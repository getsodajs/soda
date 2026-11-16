# Controllers

A controller is a class whose methods serve routes. List it in the `controllers` of a module.

```ts
@Controller('users')
export class UsersController {
  @Get()
  list(): User[] {}

  @Get(':id', [param('id', int)])
  findOne(id: number): User {}

  @Post([body(CreateUser)])
  create(input: CreateUser): User {}

  @Delete(':id', [param('id', int)])
  @HttpCode(204)
  remove(id: number): void {}
}
```

## Routes

`@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@Options` and `@Head` declare a route for their method; `@All` for every method; `@Route('PROPFIND', 'path')` for any other method name. A method may carry several route decorators.

The full path is the global prefix, the controller path and the route path, each with a leading slash and no trailing one:

```ts
await createApp(AppModule, { prefix: 'api' })

@Controller('users')   // + @Get(':id')  →  /api/users/:id
```

- `HEAD` is answered by the `GET` route unless a `@Head` route exists.
- A path with routes, but none for the method, answers `405` with an `Allow` header.
- A route for a concrete method wins over an `@All` route on the same path.
- A controller inherits the routes of its parent class; an override without a route decorator removes the route.

### Path syntax

Each special form takes a whole segment:

| Path | Matches |
|---|---|
| `/users/me` | that path |
| `/users/:id` | one non-empty segment, as `id` |
| `/users/:id{\\d+}` | a segment matching the regex, tested on the decoded value |
| `/users/:id?` | with or without the last segment; only trailing parameters are optional |
| `/files/*` | `/files` and everything below |
| `/files/*path` | the same, the decoded remainder as `path` |

Routes compile into Bun's native router. Two routes that can match the same request (the same path written twice, say) stop the startup with an error naming both.

## Arguments

The second argument of a route decorator lists what the method receives, in order. Each value is read, converted and validated before the method runs; a failure answers `400` without calling it.

```ts
@Get(':id', [param('id', int), query('fields'), header('accept-language')])
findOne(id: number, fields: string | undefined, language: string | undefined) {}
```

| Argument | Value | Nest |
|---|---|---|
| `param(name, parser?)` | path parameter, of the route or of the controller path | `@Param()` |
| `query(name, parser?)` | first value of a query parameter | `@Query()` |
| `header(name, parser?)` | request header | `@Headers()` |
| `cookie(name, parser?)` | cookie | `@Cookies()` |
| `body(schema?)` | JSON body | `@Body()` |
| `form(schema?, limits?)` | form body, files included | `@Body()` with multer |
| `value(key)` | what a guard or an interceptor attached to the request | custom decorator, `@User()` |
| `context()` | the request context itself | `@Req()` |

The types are checked: `findOne(id: string)` after `param('id', int)` is a compile error, and so is a method that does not accept what the list gives. A `param()` name that is not in the full path stops the startup and lists the parameters the path has.

Without parser, `param('id')` is a `string`, `string | undefined` for an optional parameter; `query()`, `header()` and `cookie()` are `string | undefined`. Parsers and schemas are in [Validation](./validation.md).

## The context

A route without argument list receives the request context, typed by its path:

```ts
@Get(':id')
findOne(ctx: Context<':id'>) {
  return this.#users.find(ctx.param('id'))
}
```

| Member | |
|---|---|
| `ctx.req` | Bun's `Request` |
| `ctx.param(name, parser?)`, `query()`, `header()`, `cookie()` | as the arguments above |
| `ctx.body(schema?)`, `ctx.form(schema?, limits?)` | the body; read once, in one format |
| `ctx.cookies` | Bun's `CookieMap`; what you set or delete is sent with the response |
| `ctx.responseHeaders` | headers added to the response, whatever it is |
| `ctx.url` | the parsed `URL`, built on first use |
| `ctx.ip` | address of the peer |
| `ctx.get(key)`, `ctx.set(key, value)`, `ctx.has(key)` | values attached to the request, see [Request pipeline](./request-pipeline.md) |
| `ctx.metadata(decorator)` | custom metadata of the route |
| `ctx.route` | controller, method name, HTTP method, full path |

Prefer the argument list: it is what the types, OpenAPI and the startup checks see. `context()` in the list gives the context next to other values, for cookies or response headers.

## Responses

What the method returns becomes the response, as in Nest:

| Returned | Response |
|---|---|
| a `Response` | sent as is |
| `undefined`, `null` | empty body |
| a string | `text/plain;charset=utf-8` |
| `ArrayBuffer`, typed array, `Blob`, `ReadableStream` | sent as is |
| anything else | JSON |

The status is `201` for `POST` and `200` otherwise; `@HttpCode(204)` changes it. `204`, `205` and `304` never get a body. `@Header(name, value)` adds a header to the responses built from returned values. A returned `Response` keeps its own status and headers.

Errors are responses too: throw an `HttpException` and its body is sent with its status.

```ts
throw new NotFoundException(`No user ${id}`)
// 404 {"statusCode":404,"message":"No user 1","error":"Not Found"}
```

`BadRequestException` (400), `UnauthorizedException` (401), `ForbiddenException` (403), `NotFoundException` (404), `ConflictException` (409), `PayloadTooLargeException` (413), `UnsupportedMediaTypeException` (415), `UnprocessableEntityException` (422), `TooManyRequestsException` (429), `InternalServerErrorException` (500) and `ServiceUnavailableException` (503) exist; `new HttpException(body, status)` makes any other. Any other error is logged and answered with a bare `500`, whose body says nothing about it.

## Server-sent events

An `@Sse()` route returns an async iterable of messages, streamed as `text/event-stream`:

```ts
@Sse('ticks')
async *ticks(): AsyncGenerator<SseMessage> {
  for (let i = 0; ; i++) {
    yield { data: { tick: i }, id: String(i) } // data: a string as is, anything else as JSON
    await Bun.sleep(1000)
  }
}
```

A message may also have an `event` name and a `retry` delay in milliseconds. When the client disconnects, the generator is returned, so its `finally` runs: release what it holds there. The response carries Nest's headers: no caching, no buffering by nginx.

```ts
const source = new EventSource('/ticks')
source.onmessage = (event) => console.log(JSON.parse(event.data))
```
