# Request pipeline

```
middleware → routing → guards → interceptors → arguments → handler → response
                          └──── exception filters (method, class, global) ────┘
```

Guards, interceptors and filters are what Nest calls enhancers. They are declared globally, on a controller or on a method, and run in Nest's order: global first, then class, then method; filters the other way round.

Each one comes in three forms:

- **a class**, created once per module by the container, so it can `inject()` what the controller's module sees;
- **an instance**, used as is;
- **a function**, run where `inject()` works.

## Guards

A guard decides whether a request goes on. Returning `false` answers `403 Forbidden resource`; throwing an `HttpException` answers with it.

```ts
export class ApiKeyGuard implements CanActivate {
  readonly #config = inject(AppConfig)

  canActivate(ctx: Context): boolean {
    return ctx.header('x-api-key') === this.#config.API_KEY
  }
}

@Controller('admin')
@UseGuards(ApiKeyGuard)
export class AdminController {}
```

A function works too:

```ts
const internalOnly = (ctx: Context) => ctx.ip === '127.0.0.1'

@Get('metrics')
@UseGuards(internalOnly)
metrics() {}
```

Global guards: `createApp(AppModule, { guards: [ApiKeyGuard] })`; their classes are created in the root module.

## Values of a request

A guard that finds something (the user, the tenant) attaches it to the request under a `ContextKey`; the handler receives it with `value()`:

```ts
export const USER = new ContextKey<User>('user')

export class AuthGuard implements CanActivate {
  readonly #auth = inject(AuthService)

  async canActivate(ctx: Context): Promise<boolean> {
    const user = await this.#auth.verify(ctx.header('authorization'))

    ctx.set(USER, user)

    return true
  }
}

@Get('me', [value(USER)])
@UseGuards(AuthGuard)
me(user: User) {}
```

The key carries the type, and two keys never collide. Reading a key nobody set throws an error saying the guard is probably missing on the route; `new ContextKey('locale', () => 'en')` has a default instead.

## Custom metadata

`createDecorator()` makes a decorator storing a value on a class or a method; a guard reads it with `ctx.metadata()`, the method's value over the class's. This is Nest's `Reflector`:

```ts
export const Roles = createDecorator<readonly string[]>('Roles')

export class RolesGuard implements CanActivate {
  canActivate(ctx: Context): boolean {
    const roles = ctx.metadata(Roles)

    return roles === undefined || roles.includes(ctx.get(USER).role)
  }
}

@Delete(':id', [param('id', int)])
@Roles(['admin'])
@UseGuards(AuthGuard, RolesGuard)
remove(id: number) {}
```

## Interceptors

An interceptor wraps the handler: it works before `next()`, after it, instead of it, or changes its result. `next()` is a promise of what the handler returned; there is no RxJS.

```ts
export class TimingInterceptor implements Interceptor {
  readonly #logger = inject(Logger).child('Timing')

  async intercept(ctx: Context, next: CallHandler) {
    const start = performance.now()
    const result = await next()

    this.#logger.log(`${ctx.route.method} ${ctx.route.path}`, { ms: performance.now() - start })

    return result
  }
}

@UseInterceptors(TimingInterceptor)
```

Interceptors run after the guards, so a refused request never reaches them.

## Exception filters

A filter turns an error into the response to send. `@Catch()` says which errors a class handles; without arguments, all of them.

```ts
@Catch(EntityNotFoundError)
export class NotFoundFilter implements ExceptionFilter<EntityNotFoundError> {
  catch(error: EntityNotFoundError, ctx: Context): Response {
    return Response.json({ statusCode: 404, message: error.message }, { status: 404 })
  }
}

@UseFilters(NotFoundFilter)
```

The first filter that handles the error answers, the method's first, then the class's, then the global ones. Without one, an `HttpException` is sent as its body and status, and any other error is passed to `onError` (logged by default) and answered with a bare `500`. A filter that fails falls back to that too.

## Response headers

`ctx.responseHeaders` adds headers to the response, whatever it is: a returned value, a returned `Response`, or an error. Like `res.header()` in Nest.

```ts
const noStore = (ctx: Context) => {
  ctx.responseHeaders.set('cache-control', 'no-store')

  return true
}
```

`@Header(name, value)` on a method is simpler for a fixed header.

## Middleware

Middleware runs around every request before routing: unknown paths (404), wrong methods (405) and CORS preflights included. It is the place for what concerns HTTP itself: CORS, request ids, access logs, compression.

```ts
const requestId: MiddlewareFunction = async (req, next) => {
  const response = await next()

  response.headers.set('x-request-id', crypto.randomUUID())

  return response
}

await createApp(AppModule, { middleware: [cors({ origin: 'https://app.example.com' }), requestId] })
```

The first is the outermost. A class implementing `NestMiddleware` (`use(req, next)`) is created in the root module and can `inject()`.

Middleware sees the raw `Request`, not the context: for anything that depends on the route, use a guard or an interceptor.

## CORS

```ts
cors({
  origin: ['https://app.example.com'],  // '*' (the default), a string, a list, or (origin, req) => boolean
  credentials: true,                    // cookies and Authorization from the browser
  methods: ['GET', 'POST'],             // defaults to the common ones
  allowedHeaders: ['content-type'],     // defaults to what the preflight asks for
  exposedHeaders: ['x-request-id'],
  maxAge: 600,                          // seconds the browser caches the preflight
})
```

Only real preflights (`OPTIONS` with `Access-Control-Request-Method`) are answered by `cors()`; other `OPTIONS` requests reach your routes. `credentials: true` with `origin: '*'` is refused when the middleware is created: browsers reject that pair.
