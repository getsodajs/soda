/**
 * @module
 * The logger contract.
 *
 * `Logger` is both the type and the DI token: the application provides one
 * (a `ConsoleLogger` unless told otherwise) and any class injects it.
 *
 * ```ts
 * class UsersService {
 *   readonly #logger = inject(Logger).child('UsersService')
 *
 *   create(user: User) {
 *     this.#logger.log('User created', { id: user.id })
 *   }
 * }
 * ```
 *
 * Levels are Nest's. Unlike Nest's `Logger`, it is not a static global: each
 * application has its own, and tests replace it with `overrides`.
 */

/** Levels, from the most to the least verbose. */
export const LOG_LEVELS = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'] as const

export type LogLevel = (typeof LOG_LEVELS)[number]

/** Structured data of an entry; `Error` values are serialized with their stack and cause. */
export type LogData = Readonly<Record<string, unknown>>

/**
 * One log entry, as a `Logger` implementation receives it.
 */
export interface LogEntry {
  readonly level: LogLevel
  readonly message: string
  readonly data: LogData | undefined
  /** Where it comes from, as given to `child()`. */
  readonly context: string | undefined
}

/** A route of the application, as the startup report lists it. */
export interface StartupRoute {
  /** `GET`, `POST`... `WS` for a WebSocket gateway. */
  readonly method: string
  readonly path: string
  /** `UsersController.findOne`, or the gateway class. */
  readonly handler: string
  /** What the handler reads: `body`, `form`, `query page, full`, `header x-key`; for a gateway, its events. */
  readonly inputs: readonly string[]
  /** Guards declared on the controller and the method; global ones are in the report. */
  readonly guards: readonly string[]
  /** Interceptors declared on the controller and the method. */
  readonly interceptors: readonly string[]
  /** Declared with `@Sse()`. */
  readonly sse: boolean
}

/**
 * What an application tells when it starts listening: `logger.startup(report)`.
 */
export interface StartupReport {
  /** Version of `@getsoda/core`. */
  readonly version: string
  readonly url: string
  /** Milliseconds until the server listened, from the start of the process (of `createApp()` under `--hot`). */
  readonly duration: number
  readonly modules: number
  readonly providers: number
  /** Names of the middleware, outermost first. */
  readonly middleware: readonly string[]
  /** Names of the guards and interceptors of every route. */
  readonly guards: readonly string[]
  readonly interceptors: readonly string[]
  /** Routes, then gateways, in module order. */
  readonly routes: readonly StartupRoute[]
}

/**
 * A logger. Implementations only write entries; levels and contexts are handled here.
 */
export abstract class Logger {
  /** Writes one entry. Called for every level: filtering is up to the implementation. */
  abstract write(entry: LogEntry): void

  verbose(message: string, data?: LogData): void {
    this.write({ level: 'verbose', message, data, context: undefined })
  }

  debug(message: string, data?: LogData): void {
    this.write({ level: 'debug', message, data, context: undefined })
  }

  log(message: string, data?: LogData): void {
    this.write({ level: 'log', message, data, context: undefined })
  }

  warn(message: string, data?: LogData): void {
    this.write({ level: 'warn', message, data, context: undefined })
  }

  error(message: string, data?: LogData): void {
    this.write({ level: 'error', message, data, context: undefined })
  }

  fatal(message: string, data?: LogData): void {
    this.write({ level: 'fatal', message, data, context: undefined })
  }

  /**
   * Called once the application listens. Writes one `log` entry with the
   * figures and one `debug` entry per route; `ConsoleLogger` draws a summary instead.
   */
  startup(report: StartupReport): void {
    const { routes, ...figures } = report
    const own = this.child('Soda')

    own.log(`Listening on ${report.url}`, { ...figures, routes: routes.length })

    for (const route of routes) {
      own.debug(`${route.method} ${route.path} → ${route.handler}`, {
        inputs: route.inputs,
        guards: route.guards,
        interceptors: route.interceptors,
      })
    }
  }

  /** A logger writing through this one, with `context` on every entry. */
  child(context: string): Logger {
    return new ContextLogger(this, context)
  }
}

class ContextLogger extends Logger {
  readonly #parent: Logger
  readonly #context: string

  constructor(parent: Logger, context: string) {
    super()
    this.#parent = parent
    this.#context = context
  }

  write(entry: LogEntry): void {
    this.#parent.write({ ...entry, context: this.#context })
  }

  override startup(report: StartupReport): void {
    this.#parent.startup(report)
  }
}

/** A logger that writes nothing: `createApp(AppModule, { logger: false })`. */
export class SilentLogger extends Logger {
  write(): void {}
}
