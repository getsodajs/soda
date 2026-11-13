/**
 * @module
 * Logger writing to stdout and stderr, readable for people or as JSON lines.
 *
 * ```
 * 2026-11-13T17:20:03.120Z  LOG   [UsersService] User created {"id":7}
 * {"time":"2026-11-13T17:20:03.120Z","level":"log","context":"UsersService","message":"User created","id":7}
 * ```
 *
 * Like Nest's `ConsoleLogger`: a minimum level, a JSON mode for log
 * collectors; `error` and `fatal` go to stderr, the rest to stdout.
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
}

const SEVERITY: Readonly<Record<LogLevel, number>> = { verbose: 0, debug: 1, log: 2, warn: 3, error: 4, fatal: 5 }

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

  constructor(options: ConsoleLoggerOptions = {}) {
    super()
    this.#minimum = SEVERITY[options.level ?? 'log']
    this.#json = options.json === true
    this.#output = options.output ?? writeToConsole
  }

  write(entry: LogEntry): void {
    if (SEVERITY[entry.level] < this.#minimum) {
      return
    }

    const time = new Date().toISOString()

    this.#output(this.#json ? this.#formatJson(entry, time) : this.#formatText(entry, time), entry.level)
  }

  #formatJson(entry: LogEntry, time: string): string {
    // Fixed fields last: data cannot overwrite them.
    return stringify({ ...entry.data, time, level: entry.level, context: entry.context, message: entry.message }, 'full')
  }

  #formatText(entry: LogEntry, time: string): string {
    const context = entry.context === undefined ? '' : `[${entry.context}] `
    let line = `${time}  ${entry.level.toUpperCase().padEnd(7)} ${context}${entry.message}`
    let stacks = ''

    if (entry.data !== undefined) {
      line += ` ${stringify(entry.data, 'brief')}`

      // Stacks are read better on their own lines than inside the JSON.
      for (const value of Object.values(entry.data)) {
        if (value instanceof Error && value.stack !== undefined) {
          stacks += `\n${value.stack}`
        }
      }
    }

    return line + stacks
  }
}
