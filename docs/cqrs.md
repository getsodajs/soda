# CQRS

`@getsoda/core/cqrs` separates what changes the application (commands) from what reads it (queries), and lets modules react to what happened (events), as `@nestjs/cqrs` does. Each message is a class; a bus hands it to the provider that declares it handles that class.

```ts
import { Command, CommandBus, CommandHandler, CqrsModule } from '@getsoda/core/cqrs'

export class CreateUser extends Command<User> {
  constructor(readonly name: string) {
    super()
  }
}

@CommandHandler(CreateUser)
export class CreateUserHandler {
  readonly #db = inject(Database)

  execute(command: CreateUser): Promise<User> {
    return this.#db.users.insert({ name: command.name })
  }
}

@Module({ providers: [CreateUserHandler] })
export class UsersModule {}

@Module({ imports: [CqrsModule, UsersModule] })
export class AppModule {}
```

```ts
@Controller('users')
export class UsersController {
  readonly #commands = inject(CommandBus)

  @Post([body(NewUser)])
  create(input: NewUser) {
    return this.#commands.execute(new CreateUser(input.name))   // Promise<User>
  }
}
```

`CqrsModule` is global: import it once, in the root module. A handler is a provider like any other, listed in the `providers` of its module, with its dependencies from `inject()`.

## Commands and queries

| | Command | Query |
|---|---|---|
| does | changes the state | reads it, changing nothing |
| class | `extends Command<R>` | `extends Query<R>` |
| handler | `@CommandHandler(C)`, `execute(command)` | `@QueryHandler(Q)`, `execute(query)` |
| bus | `inject(CommandBus).execute(new C())` | `inject(QueryBus).execute(new Q())` |

`R` is what the handler returns, and what `execute()` resolves with: `execute(new CreateUser('Ada'))` is a `Promise<User>`, with no type argument at the call. The compiler checks the handler against its message: `execute()` must take that command and return its `R`, or a promise of it. `Command` alone is `Command<void>`.

A command or a query has exactly one handler. `execute()` rejects with what the handler throws, an `HttpException` included, so a controller answers it as usual.

## Events

An event is any class. It has any number of handlers, in any module:

```ts
export class UserCreated {
  constructor(readonly user: User) {}
}

@EventsHandler(UserCreated)
export class SendWelcomeEmail {
  readonly #mail = inject(Mailer)

  async handle(event: UserCreated) {
    await this.#mail.send(event.user.email, 'Welcome')
  }
}
```

```ts
// in CreateUserHandler.execute()
await this.#events.publish(new UserCreated(user))
```

- Every handler runs, at the same time. `@EventsHandler(A, B)` handles both.
- A failing handler is logged (context `EventBus`) and leaves the others and the publisher alone: the welcome email that cannot be sent does not undo the user.
- `publish()` resolves once every handler has finished. Without `await`, the event is handled in the background, as in Nest.
- An event nothing handles is published to nobody, without error.

To execute a command when an event happens, which Nest does with a saga, execute it from the handler: `handle(event) { return this.#commands.execute(new OpenCart(event.user.id)) }`.

## Modules that need each other

Two services injecting each other are a circular dependency, and `soda check` reports it with the chain. Through the buses, modules need not import each other: `OrdersModule` executes `new GetUser(id)` without knowing `UsersModule` exists, and `UsersModule` publishes `UserCreated` without knowing who listens. Each depends on the buses, the buses find the handlers when a message is sent.

The link between a message and its handler is then not in the code that sends it. `soda inspect` shows it:

```
  command  CreateUser   → CreateUserHandler (UsersModule)
  query    GetUser      → GetUserHandler (UsersModule)
  event    UserCreated  → SendWelcomeEmail (MailModule)
```

`soda inspect --json` lists them under `handlers`, for an agent.

## Errors

| Code | When | Found |
|---|---|---|
| `DUPLICATE_HANDLER` | a second handler for a command or a query; two handler decorators on one class | when the class is defined |
| `NO_HANDLER` | a command or a query nothing handles | at `execute()` |
| `HANDLER_NOT_PROVIDED` | its handler is in no module's `providers` | at `execute()` |
| `AMBIGUOUS_HANDLER` | several modules provide its handler | at `execute()` |
| `INVALID_MESSAGE` | a plain object, `{ name }`, instead of `new CreateUser(...)` | at `execute()` or `publish()` |

A second handler is an error: Nest logs a warning and keeps the last one. A missing handler is found when the command is executed: nothing tells, before, which commands the code will send.

## Testing

A handler is a provider: replace it as any other.

```ts
const app = await createTestApp(AppModule, {
  overrides: [provide(SendWelcomeEmail, { useValue: { handle: () => {} } })],
})
```

## Compared with `@nestjs/cqrs`

Kept: `CommandBus`, `QueryBus`, `EventBus`, `Command<R>` and `Query<R>`, the three decorators and their methods (`execute`, `handle`), handlers found among the providers of every module.

Left out:

- **Sagas**: they need RxJS. An event handler executing a command does what a saga does.
- **`AggregateRoot` and `EventPublisher`**: an aggregate collecting events and committing them. Publish them after saving instead.
- **Custom publishers**, sending messages to a broker, and `UnhandledExceptionBus`: failures are logged.
- **Request-scoped handlers**: Soda has no request scope; what a request carries goes in the command.
