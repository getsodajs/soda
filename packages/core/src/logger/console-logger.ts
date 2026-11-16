/**
 * @module
 * Logger writing to stdout and stderr, readable for people or as JSON lines.
 *
 * ```
 * 12:22:09 LOG UsersService  User created id=7 +3ms
 * {"time":"2026-11-13T21:22:09.120Z","level":"log","context":"UsersService","message":"User created","id":7}
 * ```
 *
 * The time, the level, the context, then the message and its data as
 * `key=value`, and the time since the previous line. Colored in a terminal, in
 * Soda's palette. When the application listens, a summary of it: figures,
 * routes with what they read and their guards. `error` and `fatal` go to
 * stderr, the rest to stdout.
 */

import { Logger } from './logger.ts'
import type { LogEntry, LogLevel, StartupReport } from './logger.ts'
import { colors, PLAIN } from './palette.ts'
import type { Palette } from './palette.ts'
import { drawStartup } from './startup.ts'

export interface ConsoleLoggerOptions {
  /** Least severe level written. Defaults to `log`. */
  readonly level?: LogLevel
  /** One JSON object per line, for log collectors. Defaults to `false`. */
  readonly json?: boolean
  /** Where lines go. Defaults to stderr for `error` and `fatal`, stdout otherwise. */
  readonly output?: (line: string, level: LogLevel) => void
  /**
   * Colors. Defaults to on when writing to a terminal without `NO_COLOR`, off
   * with a custom `output`.
   */
  readonly colors?: boolean
  /** Name starting each readable line, to tell applications apart in one stream: `[Shop]`. None by default. */
  readonly prefix?: string
}

const SEVERITY: Readonly<Record<LogLevel, number>> = { verbose: 0, debug: 1, log: 2, warn: 3, error: 4, fatal: 5 }

const LABELS: Readonly<Record<LogLevel, string>> = {
  verbose: 'VRB',
  debug: 'DBG',
  log: 'LOG',
  warn: 'WRN',
  error: 'ERR',
  fatal: 'FTL',
}

const two = (n: number): string => (n < 10 ? `0${n}` : String(n))

/** `12:22:09`, local time. */
const clock = (now: number): string => {
  const date = new Date(now)

  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
}

/** Values written without quotes: `id=7`, `path=/users/7`. */
const BARE = /^[\w.:/@+-]+$/

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

/** A value of `key=value`: strings quoted when they have spaces, objects as JSON, errors as `Name: message`. */
const writeValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return BARE.test(value) ? value : JSON.stringify(value)
  }

  if (value instanceof Error) {
    return `${value.name}: ${value.message}`
  }

  return typeof value === 'object' && value !== null ? stringify(value, 'brief') : String(value)
}

const pairs = (data: Readonly<Record<string, unknown>>, palette: Palette): string => {
  let text = ''

  for (const key of Object.keys(data)) {
    text += ` ${palette.dim(`${key}=`)}${writeValue(data[key])}`
  }

  return text
}

export class ConsoleLogger extends Logger {
  readonly #minimum: number
  readonly #json: boolean
  readonly #output: (line: string, level: LogLevel) => void
  readonly #palette: Palette
  readonly #prefix: string
  /** When the previous line was written, for the `+3ms` at the end of the next. */
  #last: number | undefined

  constructor(options: ConsoleLoggerOptions = {}) {
    super()
    this.#minimum = SEVERITY[options.level ?? 'log']
    this.#json = options.json === true
    this.#output = options.output ?? writeToConsole
    this.#palette =
      (options.colors ?? (options.output === undefined && process.stdout.isTTY === true && process.env.NO_COLOR === undefined))
        ? colors()
        : PLAIN
    this.#prefix = options.prefix === undefined ? '' : `[${options.prefix}] `
  }

  write(entry: LogEntry): void {
    if (SEVERITY[entry.level] < this.#minimum) {
      return
    }

    const now = Date.now()

    this.#output(this.#json ? this.#formatJson(entry, now) : this.#formatText(entry, now), entry.level)
    this.#last = now
  }

  /** The summary of the application, written as a `log` entry; JSON lines get the entries of `Logger`. */
  override startup(report: StartupReport): void {
    if (this.#json) {
      super.startup(report)

      return
    }

    if (SEVERITY.log < this.#minimum) {
      return
    }

    this.#output(drawStartup(report, this.#palette), 'log')
    this.#last = Date.now()
  }

  #formatJson(entry: LogEntry, now: number): string {
    const time = new Date(now).toISOString()

    // Fixed fields last: data cannot overwrite them.
    return stringify({ ...entry.data, time, level: entry.level, context: entry.context, message: entry.message }, 'full')
  }

  #formatText(entry: LogEntry, now: number): string {
    const palette = this.#palette
    const { dim } = palette
    const level = palette.level[entry.level]
    const severe = SEVERITY[entry.level] >= SEVERITY.warn
    const context = entry.context === undefined ? '' : `${palette.aqua(entry.context)}  `
    const message = severe ? level(entry.message) : entry.message
    const data = entry.data === undefined ? '' : pairs(entry.data, palette)
    const since = this.#last === undefined ? '' : dim(` +${now - this.#last}ms`)
    let stacks = ''

    // Stacks are read better on their own lines.
    for (const value of Object.values(entry.data ?? {})) {
      if (value instanceof Error && value.stack !== undefined) {
        stacks += `\n${dim(value.stack)}`
      }
    }

    return `${this.#prefix}${dim(clock(now))} ${level(LABELS[entry.level])} ${context}${message}${data}${since}${stacks}`
  }
}
