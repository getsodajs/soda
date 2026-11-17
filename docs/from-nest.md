# From Nest

Soda keeps Nest's model (modules, providers, controllers, guards, interceptors, filters) and changes how it is written, because it uses standard decorators and runs on Bun.

## Why it looks different

Nest relies on two TypeScript features of the legacy decorator mode:

- **parameter decorators**, as in `create(@Body() dto: CreateUserDto)`: standard decorators have none, the syntax does not exist outside `experimentalDecorators`;
- **emitted type metadata** (`emitDecoratorMetadata`): the compiler writes the types of constructor parameters into the code, so that Nest knows what to inject and which DTO class to validate.

Soda uses neither. What a method receives is listed in its route decorator, and what a class needs is asked with `inject()`. No compiler flag, no `reflect-metadata`, and `import type` or a bundler that does not emit metadata (esbuild, Vite) cannot break injection.

## Side by side

| Nest | Soda |
|---|---|
| `constructor(private users: UsersService) {}` | `readonly #users = inject(UsersService)` |
| `@Inject(TOKEN) private value: T` | `readonly #value = inject(TOKEN)` |
| `@Optional()` | `inject(Logger, { optional: true })` |
| `{ provide: TOKEN, useFactory, inject: [A] }` | `provide(TOKEN, { useFactory, inject: [A] })`, typed |
| `'CONFIG'` string tokens | `new InjectionToken<Config>('CONFIG')`, typed |
| `@Injectable({ scope: Scope.TRANSIENT })` | `@Injectable({ scope: 'transient' })` |
| `Scope.REQUEST` | none: request data goes in the context, `ctx.set()` and `value()` |
| `onModuleInit`, `onModuleDestroy` | `onInit`, `onDestroy` |
| `@Get(':id') findOne(@Param('id', ParseIntPipe) id: number)` | `@Get(':id', [param('id', int)]) findOne(id: number)` |
| `@Body() dto: CreateUserDto` + `class-validator` | `[body(CreateUser)]` with a zod (or valibot, arktype) schema |
| `@Query('page', new DefaultValuePipe(1), ParseIntPipe)` | `[query('page', z.coerce.number().default(1))]` |
| `ClassSerializerInterceptor` + `@Exclude()` on an entity | `@Returns(User)` with a schema of what is sent |
| `@Req()`, `@Res({ passthrough: true })` | `[context()]`: `ctx.req`, `ctx.cookies`, `ctx.responseHeaders` |
| `@UploadedFile()` + multer | `[form(schema, limits)]`, files are `File`s |
| `@Headers('x')`, `@Ip()` | `[header('x')]`, `ctx.ip` |
| custom `@User()` parameter decorator | a guard does `ctx.set(USER, user)`, the route lists `value(USER)` |
| `Reflector` + `SetMetadata` | `createDecorator()` + `ctx.metadata()` |
| `NestInterceptor` with RxJS | `Interceptor` with a promise: `await next()` |
| `@Sse()` returning an `Observable` | `@Sse()` returning an async generator |
| `app.useGlobalGuards()` and the like | `createApp(AppModule, { guards, interceptors, filters, middleware })` |
| `app.setGlobalPrefix('api')` | `createApp(AppModule, { prefix: 'api' })` |
| `app.enableCors()` | `middleware: [cors()]` |
| `app.enableShutdownHooks()` | `app.enableShutdownSignals()` |
| `Test.createTestingModule()` + supertest | `createTestApp(AppModule, { overrides })` |
| `.overrideProvider(A).useValue(x)` | `overrides: [provide(A, { useValue: x })]` |
| `@nestjs/config` | `defineConfig()` + `ConfigModule`, typed by the schema |
| `@nestjs/jwt` + `@nestjs/passport` | `@getsoda/core/jwt`: `JwtModule`, `JwtGuard` |
| `@nestjs/throttler` | `@getsoda/core/throttler` |
| `@nestjs/swagger` with `@ApiProperty()` on each field | `@getsoda/core/openapi`, schemas from the validation |
| `@nestjs/websockets`, `@MessageBody()`, `@ConnectedSocket()` | `@WebSocketGateway()`, `data()`, `socket()`, on Bun's WebSockets |

## What behaves differently

- **WebSocket guards.** Class guards run on the handshake, method guards on each message; in Nest, class guards run on each message and nothing on the handshake.
- **Shutdown.** The server stops accepting requests and drains them before services are destroyed; Nest destroys services while still serving.
- **Errors.** A missing provider, a `param()` that is not in the path, two routes for one request, an invalid configuration: all stop the startup, with a message pointing to your code.
- **`ParseIntPipe`.** `int` refuses integers beyond `Number.MAX_SAFE_INTEGER` instead of rounding them.
- **Lifecycle hooks** run one after another, deterministically; Nest runs a level in parallel.
- **Logger.** Not a static global: each application has its own, injected.

## Not in Soda

- **Microservices** (`@nestjs/microservices`: Kafka, NATS, gRPC transports): use the client of your broker in a provider.
- **GraphQL** (`@nestjs/graphql`): mount `graphql-yoga` on a route.
- **CLI generators** (`nest g resource`): `bun create soda` creates projects, not files.
- **Queues, cron, cache, health, CQRS, i18n modules:** a provider wrapping the library you choose does it; see [Database](./recipes/database.md) for the pattern.

## Speed

On the same machine and Bun, Soda serves about twice the requests per second of Nest on Fastify, on par with Hono; see the [benchmark](../bench/http).
