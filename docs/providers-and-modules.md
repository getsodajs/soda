# Providers and modules

## Injecting

A class gets its dependencies with `inject()`, in a field initializer or its constructor:

```ts
export class UsersService {
  readonly #repository = inject(UsersRepository)
  readonly #logger = inject(Logger).child('UsersService')
}
```

No constructor parameters, no `reflect-metadata`: the token is written, not read from types the compiler emits. Private fields (`#name`) work, and `import type` cannot break injection.

`inject()` works while the container creates a class: in field initializers and constructors, in factories, and in function guards, interceptors and middleware (before their first `await`). Called anywhere else, it throws and says so.

`inject(Logger, { optional: true })` gives `undefined` when no provider is visible.

## Providers

A module lists providers either as a class, or with `provide()`:

```ts
@Module({
  providers: [
    UsersService,                                               // the class itself
    provide(DATABASE_URL, { useValue: process.env.DATABASE_URL }),
    provide(Mailer, { useClass: SmtpMailer }),                  // another class for the token
    provide(Cache, { useExisting: RedisCache }),                // an alias
    provide(Database, {
      inject: [DATABASE_URL, optional(Logger)],
      useFactory: async (url, logger) => connect(url, logger),  // may be async
    }),
  ],
})
export class DatabaseModule {}
```

`provide()` checks each definition against the token type: a `useValue` that is not a `Database` does not compile.

A token is a class, or an `InjectionToken` for anything else:

```ts
export const DATABASE_URL = new InjectionToken<string>('DATABASE_URL')

readonly #url = inject(DATABASE_URL) // string
```

### Scopes

| Scope | |
|---|---|
| `singleton` | the default: one instance, created at startup |
| `transient` | a new instance for each injection |

```ts
@Injectable({ scope: 'transient' })
export class Timer {}
```

There is no request scope: data of a request travels in its context (`ctx.set()`, `value()`), which keeps the graph static and costs nothing per request. See [Request pipeline](https://getsodajs.github.io/docs/request-pipeline.md#values-of-a-request).

## Modules

```ts
@Module({
  imports: [DatabaseModule],      // modules whose exports this one sees
  providers: [UsersService],
  controllers: [UsersController],
  exports: [UsersService],        // what modules importing this one see
})
export class UsersModule {}
```

A provider is visible in its module and in the modules importing one that exports it. A module may export a module it imports, re-exporting what that one exports.

`global: true` makes the exports of a module visible everywhere, without imports. Keep it for what truly is everywhere: configuration, the logger, a database.

### Dynamic modules

A static method returns a module configured at runtime, as `forRoot()` does in Nest:

```ts
@Module({})
export class MailModule {
  static forRoot(options: MailOptions): DynamicModule {
    return {
      module: MailModule,
      providers: [provide(MAIL_OPTIONS, { useValue: options }), Mailer],
      exports: [Mailer],
    }
  }
}

@Module({ imports: [MailModule.forRoot({ from: 'hello@example.com' })] })
export class AppModule {}
```

Its fields add to those of the `@Module()` decorator. `imports` also accepts a promise of a dynamic module, for options loaded asynchronously.

## Lifecycle

```ts
export class Database implements OnInit, OnDestroy {
  readonly #sql = new SQL(process.env.DATABASE_URL!)

  async onInit() {
    await this.#sql`select 1` // fail at startup, not at the first request
  }

  async onDestroy() {
    await this.#sql.close()
  }
}
```

- `onInit` runs once every singleton exists, dependencies first; the application starts after it.
- `onDestroy` runs when the application closes, dependents first, after the requests in flight have ended.

Hooks run on classes, factory results and `useValue` objects alike, one after another.

## Errors at startup

The graph is checked when the application starts. A missing provider says which class needs it, through which chain, and how to fix it:

```
DiError: No provider for UsersRepository in UsersModule (UsersService → UsersRepository). Add it to the providers of UsersModule, or import a module that exports it.
    at new UsersService (src/users/users.service.ts:4:24)
```

Cycles, a provider that is not exported, two providers of one token in a module and an override that replaces nothing are reported the same way, pointing to your code, not to the framework's.

## Outside HTTP

`createContainer()` builds the graph alone, for scripts, workers and tests:

```ts
const container = await createContainer(AppModule)
const users = container.get(UsersService)

await container.close()
```
