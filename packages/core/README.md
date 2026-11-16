# Soda

A class-based web framework for [Bun](https://bun.sh): modules, dependency injection and decorators like [Nest](https://nestjs.com), running on Bun's native router.

- **Standard decorators.** TC39 decorators, no `experimentalDecorators`, no `reflect-metadata`.
- **Native routing.** Routes compile into `Bun.serve({ routes })`; a route without guards adds ~0.1 ns to calling the handler.
- **Modules and DI.** `inject()`, providers, async factories, global and dynamic modules, lifecycle hooks. Graph errors are reported at startup with the full resolution chain.
- **Typed requests.** Path parameters are typed from the route path; bodies are validated with any [Standard Schema](https://standardschema.dev) library (zod, valibot, arktype).
- **Request pipeline.** Guards, interceptors and exception filters, as classes, instances or functions.
- **Lifecycle.** Graceful shutdown that drains requests before destroying services, shutdown signals, `bun --hot` support.

> Soda is in early development (0.x): the API may change between minor versions.

**[Documentation](https://github.com/getsodajs/soda/tree/main/docs)**: a guide per topic, recipes, and a map from Nest.

## Performance

Over HTTP, Soda keeps about 94% of the throughput of Bun's native routes alone, on par with Hono and about twice that of Nest on Fastify ([benchmark](https://github.com/getsodajs/soda/tree/main/bench/http)):

| Apple M1, Bun 1.4.3 | GET / | GET /id/:id?name= | POST /json |
|---|---:|---:|---:|
| Bun (native routes) | 132,064 | 109,145 | 89,249 |
| Hono | 124,124 | 103,020 | 80,846 |
| **Soda** | **126,058** | **103,634** | **81,630** |
| Nest (Fastify) | 59,874 | 52,124 | 42,984 |
| Nest (Express) | 50,409 | 46,839 | 34,726 |

Requests per second, median of 3 rounds, 100 connections.

## Install

```bash
bun add @getsoda/core
```

Requires Bun 1.4 or later. No TypeScript flags are needed for decorators.

## Quick start

```ts
import { Controller, Get, Module, Post, body, createApp, inject, int, param } from '@getsoda/core'
import type { Context } from '@getsoda/core'
import { z } from 'zod'

const CreateUser = z.object({ name: z.string().min(1) })

class UsersService {
  readonly #users = new Map<number, { id: number; name: string }>()

  find(id: number) {
    return this.#users.get(id)
  }

  create(name: string) {
    const user = { id: this.#users.size + 1, name }

    this.#users.set(user.id, user)

    return user
  }
}

@Controller('users')
class UsersController {
  readonly #users = inject(UsersService)

  // Ready values, Nest style
  @Get(':id', [param('id', int)])
  findOne(id: number) {
    return this.#users.find(id)
  }

  // Or read from the context where needed
  @Post()
  async create(ctx: Context) {
    const { name } = await ctx.body(CreateUser)

    return this.#users.create(name)
  }
}

@Module({ providers: [UsersService], controllers: [UsersController] })
class AppModule {}

const app = await createApp(AppModule)

app.enableShutdownSignals()
await app.listen(3000)
```

## Configuration

A configuration is a schema over the environment (Bun loads `.env` files into it), validated when the application starts and injected with its type:

```ts
import { ConfigModule, defineConfig } from '@getsoda/core'
import { z } from 'zod'

export const AppConfig = defineConfig('app', z.object({
  PORT: z.coerce.number().default(3000),
  JWT_SECRET: z.string().min(32),
}))

@Module({ imports: [ConfigModule.forRoot({ load: [AppConfig], global: true })] })
class AppModule {}

class AuthService {
  readonly #config = inject(AppConfig) // { PORT: number; JWT_SECRET: string }
}
```

An invalid environment stops the startup with every issue listed. `defineConfig(name, schema, (env) => ({ ... }))` builds nested configurations; tests replace one with `overrides: [provide(AppConfig, { useValue })]`.

## Cookies

`ctx.cookies` is Bun's `CookieMap` for the request: what you set or delete is sent with the response, whatever the response is. Signed cookies can be read by the client but not forged:

```ts
import { CookieSigner, cookie, signed } from '@getsoda/core'

const signer = new CookieSigner(process.env.COOKIE_SECRET!) // or [current, previous] to rotate

@Controller('session')
class SessionController {
  @Post()
  login(ctx: Context) {
    ctx.cookies.set('session', signer.sign('user-1'), { httpOnly: true, secure: true, sameSite: 'strict' })
  }

  @Get([cookie('session', signed(signer))]) // 400 when missing or forged
  me(userId: string) {
    return { userId }
  }
}
```

Name cookies that guard sessions with the `__Host-` prefix: browsers then refuse them from subdomains and over HTTP.

## Server-sent events

An `@Sse()` route returns an async iterable of messages, streamed as `text/event-stream`; when the client disconnects, the generator is returned and its `finally` runs:

```ts
@Sse('ticks')
async *ticks(): AsyncGenerator<SseMessage> {
  for (let i = 0; ; i++) {
    yield { data: { tick: i }, id: String(i) } // also event and retry
    await Bun.sleep(1000)
  }
}
```

## WebSockets

A gateway is listed in `controllers` like a controller. Its class guards run on the handshake, a method's guards on each of its messages, and frames follow the protocol of Nest's `WsAdapter`, `{ "event": "...", "data": ... }`:

```ts
const Say = z.object({ text: z.string().min(1) })

@WebSocketGateway('/chat')
@UseGuards(JwtGuard) // browsers send cookies with the handshake
class ChatGateway implements OnGatewayConnection {
  handleConnection(socket: GatewaySocket) {
    socket.subscribe('room')
  }

  @SubscribeMessage('say', [data(Say), value(JWT_PAYLOAD), socket()])
  say(message: z.infer<typeof Say>, user: JwtPayload, client: GatewaySocket) {
    client.publish('room', JSON.stringify({ event: 'said', data: { user: user.sub, text: message.text } }))
    return { event: 'sent' } // sent back to this socket
  }
}
```

`socket` is Bun's `ServerWebSocket`, with its pub/sub. Invalid data, a refused message or a failed handler is answered with an `exception` event, as Nest's `BaseWsExceptionFilter` does; frames that are not such JSON are dropped; when the application closes, sockets are closed with code 1001.

## JWT

`@getsoda/core/jwt` signs and verifies JSON Web Tokens with WebCrypto: HS256/384/512, RS, PS, ES and EdDSA, keys as secrets, PEM, JWK or `CryptoKey`. The algorithm is fixed by the options, never read from the token, so `alg: none` and algorithm confusion are refused.

```ts
import { JWT_PAYLOAD, JwtGuard, JwtModule, JwtService } from '@getsoda/core/jwt'
import type { JwtPayload } from '@getsoda/core/jwt'

@Controller('auth')
class AuthController {
  readonly #jwt = inject(JwtService)

  @Post('login')
  async login() {
    return { token: await this.#jwt.sign({ sub: 'user-1' }) }
  }

  @Get('me', [value(JWT_PAYLOAD)])
  @UseGuards(JwtGuard) // Authorization: Bearer <token>, or the `cookie` option; 401 otherwise
  me(payload: JwtPayload) {
    return payload
  }
}

@Module({
  imports: [JwtModule.register({ secret: process.env.JWT_SECRET!, expiresIn: 15 * 60 })],
  controllers: [AuthController],
})
class AuthModule {}
```

`JwtModule.registerAsync({ inject, useFactory })` takes the options from other providers; `new JwtService(options)` works without the module.

## Rate limiting

`@getsoda/core/throttler` limits the requests of each client on each route, as `@nestjs/throttler` does, answering `429` with `Retry-After` past the limit:

```ts
import { SkipThrottle, Throttle, ThrottlerGuard, ThrottlerModule } from '@getsoda/core/throttler'

@Module({ imports: [ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 100 }] })] })
class AppModule {}

await createApp(AppModule, { guards: [ThrottlerGuard] })

@Post('login')
@Throttle({ default: { limit: 5, ttl: 60_000 } })
login() {}
```

Counts live in memory by default; a `ThrottlerStorage` shares them between instances.

## OpenAPI

`@getsoda/core/openapi` describes the routes from what validates them: argument parsers and schemas implementing [Standard JSON Schema](https://standardschema.dev) (zod does). Import the module to serve the document and a Swagger UI page:

```ts
import { ApiBearerAuth, ApiOperation, ApiResponses, ApiTags, OpenApiModule } from '@getsoda/core/openapi'

@Controller('users')
@ApiTags('users')
class UsersController {
  @Get(':id', [param('id', int)])
  @ApiOperation({ summary: 'One user' })
  @ApiResponses({ 200: { description: 'The user', schema: User }, 404: { description: 'No such user' } })
  findOne(id: number) {}
}

@Module({ imports: [OpenApiModule.forRoot({ info: { title: 'Shop', version: '1.0.0' }, ui: '/docs' })] })
class AppModule {}
```

`/openapi.json` and `/docs` follow the global prefix; `@ApiExclude()` leaves a route out, `createOpenApiDocument(inject(ROUTES).controllers, options)` gives the document itself.

## Testing

`@getsoda/core/testing` serves the application on a free port with a silent logger; `overrides` replace providers, as Nest's `overrideProvider()`:

```ts
import { createTestApp } from '@getsoda/core/testing'

const app = await createTestApp(AppModule, { overrides: [provide(Mailer, { useValue: fakeMailer })] })

afterAll(() => app.close()) // or `await using app = ...` in a block

test('signs up', async () => {
  const response = await app.request('/users', { method: 'POST', json: { name: 'Bo' } })

  expect(response.status).toBe(201)
})
```

A single service needs no server: `createContainer(UsersModule, { overrides })`.

## License

[MIT](./LICENSE)
