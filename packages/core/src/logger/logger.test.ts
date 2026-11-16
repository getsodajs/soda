import { describe, expect, it } from 'bun:test'
import { ConsoleLogger } from './console-logger.ts'
import type { ConsoleLoggerOptions } from './console-logger.ts'
import { SilentLogger } from './logger.ts'
import type { LogLevel, StartupReport } from './logger.ts'

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

    logger.child('Database').error('Query failed', { query: 'select 1', table: 'users', error })

    const [line, ...stack] = lines[0]!.line.split('\n')

    expect(line).toMatch(/^\d{2}:\d{2}:\d{2} ERR Database {2}Query failed query="select 1" table=users error=Error: connection refused$/)
    expect(stack.join('\n')).toBe(error.stack!)
  })

  it('colors only when asked with a custom output, takes a prefix, and adds the time since the previous line', () => {
    const plain = capture({ prefix: 'Api' })
    const colored = capture({ colors: true })

    plain.logger.log('first')
    plain.logger.log('second', { nested: { a: 1 } })
    colored.logger.warn('careful')

    expect(plain.lines[0]!.line).toMatch(/^\[Api\] \d{2}:\d{2}:\d{2} LOG first$/)
    expect(plain.lines[1]!.line).toMatch(/ LOG second nested=\{"a":1\} \+\d+ms$/)
    expect(colored.lines[0]!.line).toContain('\u001B[')
    expect(Bun.stripANSI(colored.lines[0]!.line)).toMatch(/^\d{2}:\d{2}:\d{2} WRN careful$/)
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

describe('startup summary', () => {
  const report: StartupReport = {
    version: '1.2.3',
    url: 'http://localhost:3000/',
    duration: 41.4,
    modules: 3,
    providers: 1,
    middleware: ['cors'],
    guards: ['ThrottlerGuard'],
    interceptors: [],
    routes: [
      { method: 'GET', path: '/users', handler: 'UsersController.findAll', inputs: ['query page'], guards: [], interceptors: [], sse: false },
      { method: 'DELETE', path: '/users/:id', handler: 'UsersController.remove', inputs: [], guards: ['JwtGuard'], interceptors: [], sse: false },
      { method: 'GET', path: '/events', handler: 'EventsController.stream', inputs: [], guards: [], interceptors: [], sse: true },
      { method: 'WS', path: '/chat', handler: 'ChatGateway', inputs: ['message, typing'], guards: [], interceptors: [], sse: false },
    ],
  }

  it('draws the figures and a table of the routes', () => {
    const { logger, lines } = capture()

    logger.startup(report)

    expect(lines).toHaveLength(1)
    expect(lines[0]!.line).toBe(
      [
        '',
        '  soda 1.2.3  ready in 41 ms  →  http://localhost:3000/',
        '',
        '  3 modules · 1 provider · 3 routes · 1 gateway',
        '  middleware   cors',
        '  every route  ThrottlerGuard',
        '',
        '  GET     /users      UsersController.findAll  query page',
        '  DELETE  /users/:id  UsersController.remove   JwtGuard',
        '  GET     /events     EventsController.stream  sse',
        '  WS      /chat       ChatGateway              message, typing',
        '',
      ].join('\n')
    )
  })

  it('has the same layout in colors, and nothing below the log level', () => {
    const plain = capture()
    const colored = capture({ colors: true })
    const quiet = capture({ level: 'warn' })

    plain.logger.startup(report)
    colored.logger.startup(report)
    quiet.logger.startup(report)

    expect(colored.lines[0]!.line).not.toBe(plain.lines[0]!.line)
    expect(Bun.stripANSI(colored.lines[0]!.line)).toBe(plain.lines[0]!.line)
    expect(quiet.lines).toEqual([])
  })

  it('writes entries in JSON: the figures, then each route at debug level', () => {
    const { logger, lines } = capture({ json: true, level: 'debug' })

    logger.child('Anything').startup(report)

    const entries = lines.map(({ line }) => JSON.parse(line))

    expect(entries[0]).toMatchObject({ level: 'log', context: 'Soda', message: 'Listening on http://localhost:3000/', modules: 3, routes: 4 })
    expect(entries.slice(1).map((entry) => entry.message)).toEqual([
      'GET /users → UsersController.findAll',
      'DELETE /users/:id → UsersController.remove',
      'GET /events → EventsController.stream',
      'WS /chat → ChatGateway',
    ])
  })
})

describe('SilentLogger', () => {
  it('writes nothing', () => {
    expect(() => new SilentLogger().fatal('ignored', { any: 'data' })).not.toThrow()
  })
})
