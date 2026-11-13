/**
 * @module
 * Logger writing to stdout and stderr, readable for people or as JSON lines.
 *
 * ```
 * [Soda] 41250  - 11/14/2026, 12:22:09 AM     LOG [UsersService] User created {"id":7} +3ms
 * {"time":"2026-11-13T21:22:09.120Z","level":"log","context":"UsersService","message":"User created","id":7}
 * ```
 *
 * Like Nest's `ConsoleLogger`: the same line layout, colored by level in a
 * terminal, with the time since the previous line; a minimum level; a JSON
 * mode for log collectors. `error` and `fatal` go to stderr, the rest to stdout.
 */

import { Logger } from './logger.ts'
import type { LogEntry, LogLevel } from './logger.ts'

export interface ConsoleLoggerOptions {
  /** Least severe level written. Defaults to `log`. */
  readonly level?: LogLevel
  /** One JSON object per line, for log collectors. Defaults to `false`. */
  readonly json?: boolean
  /** Where lines go. Defaults to stderr for `error` and `fatal`, stdout otherwise. */
  readonly output?: (line: string, level: LogLevel) => void
  /**
   * Colors by level. Defaults to on when writing to a terminal without
   * `NO_COLOR`, off with a custom `output`.
   */
  readonly colors?: boolean
  /** Name starting each readable line. Defaults to `Soda`. */
  readonly prefix?: string
}

const SEVERITY: Readonly<Record<LogLevel, number>> = { verbose: 0, debug: 1, log: 2, warn: 3, error: 4, fatal: 5 }

const color =
  (code: string) =>
  (text: string): string =>
    `\u001B[${code}m${text}\u001B[0m`

const LEVEL_COLORS: Readonly<Record<LogLevel, (text: string) => string>> = {
  verbose: color('96'),
  debug: color('95'),
  log: color('32'),
  warn: color('33'),
  error: color('31'),
  fatal: color('1;31'),
}
const yellow = color('38;5;3')
const plain = (text: string): string => text

const dateTime = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
})

const writeToConsole = (line: string, level: LogLevel): void => {
  const stream = level === 'error' || level === 'fatal' ? process.stderr : process.stdout

  stream.write(`${line}\n`)
}

const serializeError = (error: Error): Record<string, unknown> => {
  const serialized: Record<string, unknown> = { name: error.name, message: error.message, stack: error.stack }

  if (error.cause !== undefined) {
    serialized.cause = error.cause instanceof Error ? serializeError(error.cause) : error.cause
  }

  return serialized
}

/**
 * `JSON.stringify` that never throws: bigints become strings, an object met a
 * second time (a cycle) becomes `"[Circular]"`. Errors are serialized in full
 * (stack and cause) for JSON lines, or as `Name: message` when their stack is
 * printed on its own lines.
 */
const stringify = (value: unknown, errors: 'full' | 'brief'): string => {
  const seen = new WeakSet<object>()

  return JSON.stringify(value, (_key, current: unknown) => {
    if (typeof current === 'bigint') {
      return current.toString()
    }

    if (current instanceof Error) {
      return errors === 'full' ? serializeError(current) : `${current.name}: ${current.message}`
    }

    if (typeof current === 'object' && current !== null) {
      if (seen.has(current)) {
        return '[Circular]'
      }

      seen.add(current)
    }

    return current
  })
}

export class ConsoleLogger extends Logger {
  readonly #minimum: number
  readonly #json: boolean
  readonly #output: (line: string, level: LogLevel) => void
  readonly #colors: boolean
  readonly #prefix: string
  /** When the previous line was written, for the `+3ms` at the end of the next. */
  #last: number | undefined

  constructor(options: ConsoleLoggerOptions = {}) {
    super()
    this.#minimum = SEVERITY[options.level ?? 'log']
    this.#json = options.json === true
    this.#output = options.output ?? writeToConsole
    this.#colors = options.colors ?? (options.output === undefined && process.stdout.isTTY === true && process.env.NO_COLOR === undefined)
    this.#prefix = options.prefix ?? 'Soda'
  }

  write(entry: LogEntry): void {
    if (SEVERITY[entry.level] < this.#minimum) {
      return
    }

    const now = Date.now()

    this.#output(this.#json ? this.#formatJson(entry, now) : this.#formatText(entry, now), entry.level)
    this.#last = now
  }

  #formatJson(entry: LogEntry, now: number): string {
    const time = new Date(now).toISOString()

    // Fixed fields last: data cannot overwrite them.
    return stringify({ ...entry.data, time, level: entry.level, context: entry.context, message: entry.message }, 'full')
  }

  #formatText(entry: LogEntry, now: number): string {
    const level = this.#colors ? LEVEL_COLORS[entry.level] : plain
    const accent = this.#colors ? yellow : plain
    const context = entry.context === undefined ? '' : accent(`[${entry.context}] `)
    const since = this.#last === undefined ? '' : accent(` +${now - this.#last}ms`)
    const data = entry.data === undefined ? '' : ` ${stringify(entry.data, 'brief')}`
    const line =
      `${level(`[${this.#prefix}] ${process.pid}  - `)}${dateTime.format(now)} ${level(entry.level.toUpperCase().padStart(7))} ` +
      `${context}${level(entry.message)}${data}${since}`
    let stacks = ''

    // Stacks are read better on their own lines than inside the JSON.
    for (const value of Object.values(entry.data ?? {})) {
      if (value instanceof Error && value.stack !== undefined) {
        stacks += `\n${value.stack}`
      }
    }

    return line + stacks
  }
}
