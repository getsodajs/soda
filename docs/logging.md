# Logging

The application has a `Logger`, injectable everywhere. By default a `ConsoleLogger`, writing lines as Nest does:

```
[Soda] 76590  - 11/16/2026, 12:10:15 PM     LOG [Soda] Starting application
[Soda] 76590  - 11/16/2026, 12:10:15 PM     LOG [Container] AppModule dependencies initialized +6ms
[Soda] 76590  - 11/16/2026, 12:10:15 PM     LOG [Routes] UsersController {/users}: +0ms
[Soda] 76590  - 11/16/2026, 12:10:15 PM     LOG [Routes] Mapped {/users/:id, GET} route +0ms
[Soda] 76590  - 11/16/2026, 12:10:15 PM     LOG [Soda] Application started +0ms
```

```ts
export class UsersService {
  readonly #logger = inject(Logger).child('UsersService')

  create(user: User) {
    this.#logger.log('User created', { id: user.id })
  }
}
```

Levels, from the most verbose: `verbose`, `debug`, `log`, `warn`, `error`, `fatal`. The second argument is structured data; `Error` values in it are written with their stack and cause.

`child(context)` gives a logger whose entries carry that context, the `[UsersService]` of the line.

## Options

```ts
import { ConsoleLogger } from '@getsoda/core'

await createApp(AppModule, {
  logger: new ConsoleLogger({
    level: 'debug',          // least severe level written; `log` by default
    json: true,              // one JSON object per line, for log collectors
    prefix: 'Shop',          // instead of [Soda]
    colors: false,           // on in a terminal without NO_COLOR
  }),
})
```

`logger: false` writes nothing. In production, `json: true` gives each entry with its level, time, context and data as fields.

## Your own logger

A logger only writes entries; levels and contexts are handled for it:

```ts
import { Logger } from '@getsoda/core'
import type { LogEntry } from '@getsoda/core'
import pino from 'pino'

export class PinoLogger extends Logger {
  readonly #pino = pino()

  write(entry: LogEntry): void {
    this.#pino[entry.level === 'verbose' ? 'trace' : entry.level]({ context: entry.context, ...entry.data }, entry.message)
  }
}

await createApp(AppModule, { logger: new PinoLogger() })
```

Unlike Nest's `Logger`, it is not a static global: each application has its own, and tests replace it.

## Errors

Errors that no filter handles and that are not `HttpException`s are logged with their request; the client gets a bare `500`. `onError: (error, req) => ...` in the options of `createApp()` receives them instead, to send them to an error tracker.
