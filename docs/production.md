# Production

## Build

```bash
bun run build       # bun build src/main.ts --target bun --outdir dist --minify --sourcemap=linked
bun run start:prod  # bun dist/main.js
```

The bundle holds your code and its dependencies in one file. Running the sources with `bun src/main.ts` works too: Bun runs TypeScript as is, and the bundle mostly saves startup time.

## Shutdown

```ts
const app = await createApp(AppModule)

app.enableShutdownSignals() // SIGTERM and SIGINT
await app.listen(Number(process.env.PORT ?? 3000))
```

On `SIGTERM` (what Docker, Kubernetes and most hosts send), the application:

1. stops accepting requests;
2. waits for the requests in flight, and closes WebSocket connections with `1001`;
3. runs `onDestroy` hooks: guards and the like, then services, dependents first;
4. lets the signal end the process.

Nest destroys services while its server still accepts requests; here no request meets a closed database. `enableShutdownSignals()` is off by default, as Nest's `enableShutdownHooks()`.

## Behind a proxy

Behind nginx, a load balancer or a platform's router, the peer of every request is the proxy:

- `ctx.ip` is the proxy's address. Read the client from `x-forwarded-for`, only the part your proxy appends: see [Rate limiting](https://getsodajs.github.io/soda/docs/rate-limiting.md#who-is-a-client).
- `ctx.url` has the scheme and host the proxy used to reach the application.
- Cookies with `secure: true` need HTTPS between the browser and the proxy, which is the usual setup.

## Limits

| Limit | Where | Default |
|---|---|---|
| request body | `app.listen({ maxRequestBodySize })` | Bun's 128 MiB |
| form body, files | `form(schema, { maxBodySize, maxFileSize, maxFiles, maxFields })` | none beyond the request body |
| WebSocket frame | `app.listen({ websocket: { maxPayloadLength } })` | Bun's 16 MiB |
| requests per client | [Rate limiting](https://getsodajs.github.io/soda/docs/rate-limiting.md) | none |

Lower the body limit to what your routes accept: a megabyte is plenty for JSON APIs.

```ts
await app.listen({ port: 3000, maxRequestBodySize: 1024 * 1024 })
```

## Logs

`new ConsoleLogger({ json: true })` writes one JSON object per line, for log collectors. See [Logging](https://getsodajs.github.io/soda/docs/logging.md).

## Errors

The client never sees an unexpected error: it gets a bare `500`, and the error goes to `onError`, which logs it by default. Send errors to a tracker there:

```ts
await createApp(AppModule, {
  onError: (error, req) => Sentry.captureException(error, { extra: { url: req.url } }),
})
```

## Health checks

A route is enough:

```ts
@Controller('health')
@SkipThrottle()
export class HealthController {
  readonly #db = inject(Database)

  @Get()
  async check() {
    await this.#db.sql`select 1` // 500 when the database is down
    return { status: 'ok' }
  }
}
```

## Docker

```dockerfile
FROM oven/bun:1.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.4-slim
WORKDIR /app
COPY --from=build /app/dist ./dist
ENV NODE_ENV=production
EXPOSE 3000
USER bun
CMD ["bun", "dist/main.js"]
```

The bundle needs no `node_modules`. `CMD` in the exec form makes `bun` the first process, so it receives `SIGTERM` itself and shuts down gracefully.

## Development

`bun dev` runs `bun --hot`: a change re-runs the changed modules in the same process, and the new version of the application takes the server over from the previous one, which is destroyed. Requests the old version is still serving at that moment may meet its destroyed services; it never happens in production, which does not run `--hot`.
