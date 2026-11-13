import { describe, expect, it } from 'bun:test'
import { ConsoleLogger } from './console-logger.ts'
import type { ConsoleLoggerOptions } from './console-logger.ts'
import { SilentLogger } from './logger.ts'
import type { LogLevel } from './logger.ts'

/** A console logger writing into an array. */
const capture = (options: Omit<ConsoleLoggerOptions, 'output'> = {}) => {
  const lines: { line: string; level: LogLevel }[] = []
  const logger = new ConsoleLogger({ ...options, output: (line, level) => lines.push({ line, level }) })

  return { logger, lines }
}

describe('ConsoleLogger', () => {
  it('writes from the configured level up', () => {
    const { logger, lines } = capture({ level: 'warn' })

    logger.debug('hidden')
    logger.log('hidden')
    logger.warn('shown')
    logger.fatal('shown too')

    expect(lines.map((entry) => entry.level)).toEqual(['warn', 'fatal'])
  })

  it('writes readable lines with context and data, and stacks on their own lines', () => {
    const { logger, lines } = capture()
    const error = new Error('connection refused')

    logger.child('Database').error('Query failed', { query: 'select 1', error })

    const [line, ...stack] = lines[0]!.line.split('\n')

    expect(line).toMatch(
      new RegExp(`^\\[Soda\\] ${process.pid} {2}- .+ {3}ERROR \\[Database\\] Query failed \\{"query":"select 1","error":"Error: connection refused"\\}$`)
    )
    expect(stack.join('\n')).toBe(error.stack!)
  })

  it('colors only when asked with a custom output, takes a prefix, and adds the time since the previous line', () => {
    const plain = capture({ prefix: 'Api' })
    const colored = capture({ colors: true })

    plain.logger.log('first')
    plain.logger.log('second')
    colored.logger.warn('careful')

    expect(plain.lines[0]!.line).toMatch(/^\[Api\] \d+ {2}- .+ {5}LOG first$/)
    expect(plain.lines[1]!.line).toMatch(/ {5}LOG second \+\d+ms$/)
    expect(colored.lines[0]!.line).toStartWith('\u001B[33m[Soda] ')
    expect(colored.lines[0]!.line).toContain('\u001B[33m   WARN\u001B[0m')
  })

  it('writes JSON lines that log collectors can parse, whatever the data', () => {
    const { logger, lines } = capture({ json: true })
    const cyclic: Record<string, unknown> = { name: 'node' }

    cyclic.self = cyclic
    logger.child('Users').log('Created', {
      id: 10n,
      node: cyclic,
      error: new Error('outer', { cause: new Error('inner') }),
      level: 'spoofed',
    })

    const entry = JSON.parse(lines[0]!.line)

    expect(entry).toMatchObject({
      level: 'log',
      context: 'Users',
      message: 'Created',
      id: '10',
      node: { name: 'node', self: '[Circular]' },
      error: { name: 'Error', message: 'outer', cause: { name: 'Error', message: 'inner' } },
    })
    expect(typeof entry.error.stack).toBe('string')
    expect(Date.parse(entry.time)).not.toBeNaN()
  })
})

describe('SilentLogger', () => {
  it('writes nothing', () => {
    expect(() => new SilentLogger().fatal('ignored', { any: 'data' })).not.toThrow()
  })
})
