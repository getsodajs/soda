# Logging

The application has a `Logger`, injectable everywhere. By default a `ConsoleLogger`, which draws a summary of the application once it listens:

```
  soda 0.4.0  ready in 41 ms  →  http://localhost:3000/

  4 modules · 12 providers · 5 routes · 1 gateway
  middleware   cors · requestId
  every route  ThrottlerGuard

  GET     /users           UsersController.findAll  query page
  GET     /users/:id       UsersController.findOne  JwtGuard
  POST    /users           UsersController.create   body  JwtGuard RolesGuard
  POST    /users/me/photo  UsersController.upload   form  JwtGuard
  GET     /events          EventsController.stream  sse
  WS      /chat            ChatGateway              message, typing
```

Each route shows what it reads (`query`, `header`, `cookie`, `body`, `form`), then the guards and interceptors of its controller and method; those of every route are listed once above. Under `bun --hot`, the summary comes again after each reload, timed from the reload.

Then one line per entry: the time, the level, the context, the message and its data.

```
12:22:09 LOG UsersService  User created id=7 email=ann@example.com +3ms
12:22:10 ERR Database  Query failed query="select 1" error=Error: connection refused +1ms
Error: connection refused
    at Database.query (src/database/database.ts:18:11)
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

`child(context)` gives a logger whose entries carry that context, the `UsersService` of the line.

Writing costs nothing on the requests themselves: Soda logs nothing per request unless asked, and the summary is drawn once, when the server listens.

## Requests

`requestLog()` writes one entry per request, once it is answered. Like `cors()`, it is middleware, off unless listed:

```ts
import { createApp, requestLog } from '@getsoda/core'

await createApp(AppModule, { middleware: [requestLog()] })
```

```
23:31:07 LOG HTTP  GET /v1/web/me status=200 ms=3
23:31:09 WRN HTTP  POST /v1/web/auth/code status=422 ms=1
23:31:12 ERR HTTP  DELETE /v1/admin/nodes/abc status=500 ms=12
```

The level follows the status: `log` below 400, `warn` for 4xx, `error` for 5xx. A logger with `level: 'warn'` keeps only the failures; with `json: true`, `status` and `ms` are fields. The query is left out, as it may carry tokens. List it first to time the whole request, other middleware included.

## Options

```ts
import { ConsoleLogger } from '@getsoda/core'

await createApp(AppModule, {
  logger: new ConsoleLogger({
    level: 'debug',          // least severe level written; `log` by default
    json: true,              // one JSON object per line, for log collectors
    prefix: 'Shop',          // [Shop] at the start of each line, to tell applications apart
    colors: false,           // on in a terminal without NO_COLOR
  }),
})
```

`logger: false` writes nothing. In production, `json: true` gives each entry with its level, time, context and data as fields; instead of the summary, one `Listening on` entry with the figures, and one `debug` entry per route.

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

`startup(report)` receives the summary as data (`StartupReport`: the version, the URL, the figures, each route); override it to show the application your way.

Unlike Nest's `Logger`, it is not a static global: each application has its own, and tests replace it.

## Errors

Errors that no filter handles and that are not `HttpException`s are logged with their request; the client gets a bare `500`. `onError: (error, req) => ...` in the options of `createApp()` receives them instead, to send them to an error tracker.
