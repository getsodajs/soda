import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { inject, InjectionToken, Injectable, Module, optional, provide } from '../di/index.ts'
import { body, Controller, cors, form, Get, int, param, Post, query, Returns, UseGuards } from '../http/index.ts'
import type { CanActivate } from '../http/index.ts'
import { Logger } from '../logger/index.ts'
import { VERSION } from '../version.ts'
import { SubscribeMessage, WebSocketGateway } from '../websocket/index.ts'
import { inspectApp } from './inspect.ts'

const SOURCE = join(import.meta.dir, '..')
const directory = await mkdtemp(join(tmpdir(), 'soda-inspect-'))

afterAll(() => rm(directory, { recursive: true, force: true }))

describe('inspectApp', () => {
  const URL_TOKEN = new InjectionToken<string>('URL')

  class Database {}

  class UsersRepository {
    readonly database = inject(Database)
  }

  @Injectable({ scope: 'transient' })
  class Clock {}

  class UsersService {
    readonly repository = inject(UsersRepository)
    readonly logger = inject(Logger)
    readonly clock = inject(Clock)
    readonly cache = inject(URL_TOKEN, { optional: true })
  }

  class JwtGuard implements CanActivate {
    canActivate(): boolean {
      return true
    }
  }

  const CreateUser = z.object({ name: z.string() })

  @Controller('/users')
  @UseGuards(JwtGuard)
  class UsersController {
    readonly users = inject(UsersService)

    @Get(':id', [param('id', int), query('full', z.stringbool().optional())])
    findOne(): void {}

    @Post('', [body(CreateUser)])
    @Returns(CreateUser)
    create() {
      return { name: 'Ada' }
    }

    @Post('avatar', [form(z.object({ avatar: z.instanceof(File) }))])
    avatar(): void {}
  }

  @WebSocketGateway('/chat')
  class ChatGateway {
    @SubscribeMessage('message')
    message(): void {}
  }

  @Module({
    providers: [Database, UsersRepository, provide(URL_TOKEN, { inject: [optional(Logger)], useFactory: () => 'postgres://' })],
    exports: [UsersRepository],
  })
  class DatabaseModule {}

  @Module({ imports: [DatabaseModule], providers: [UsersService, Clock], controllers: [UsersController, ChatGateway] })
  class UsersModule {}

  it('describes the modules and what each provider injects, from which module', async () => {
    const report = await inspectApp(UsersModule, { middleware: [cors()] })

    expect(report).toMatchObject({ version: VERSION, ok: true, problems: [], middleware: ['cors'], guards: [], interceptors: [] })
    expect(report.modules).toEqual([
      {
        name: 'DatabaseModule',
        global: false,
        imports: [],
        exports: ['UsersRepository'],
        providers: [
          { token: 'Database', kind: 'class', scope: 'singleton', injects: [] },
          { token: 'UsersRepository', kind: 'class', scope: 'singleton', injects: [{ token: 'Database', optional: false, from: 'DatabaseModule' }] },
          { token: 'InjectionToken(URL)', kind: 'factory', scope: 'singleton', injects: [{ token: 'Logger', optional: true, from: 'application' }] },
        ],
        controllers: [],
      },
      {
        name: 'UsersModule',
        global: false,
        imports: ['DatabaseModule'],
        exports: [],
        providers: [
          {
            token: 'UsersService',
            kind: 'class',
            scope: 'singleton',
            injects: [
              { token: 'UsersRepository', optional: false, from: 'DatabaseModule' },
              { token: 'Logger', optional: false, from: 'application' },
              { token: 'Clock', optional: false, from: 'UsersModule' },
              { token: 'InjectionToken(URL)', optional: true, from: undefined },
            ],
          },
          { token: 'Clock', kind: 'class', scope: 'transient', injects: [] },
        ],
        controllers: [
          { token: 'UsersController', kind: 'class', scope: 'singleton', injects: [{ token: 'UsersService', optional: false, from: 'UsersModule' }] },
          { token: 'ChatGateway', kind: 'class', scope: 'singleton', injects: [] },
        ],
      },
    ])
  })

  it('describes each route: what it reads and returns with their JSON Schema, its guards, its module', async () => {
    const { routes } = await inspectApp(UsersModule)

    expect(routes).toEqual([
      {
        method: 'GET',
        path: '/users/:id',
        handler: 'UsersController.findOne',
        module: 'UsersModule',
        inputs: [
          { kind: 'param', name: 'id', required: true, schema: { type: 'integer' } },
          { kind: 'query', name: 'full', required: false, schema: expect.any(Object) },
        ],
        guards: ['JwtGuard'],
        interceptors: [],
        status: 200,
        sse: false,
      },
      {
        method: 'POST',
        path: '/users',
        handler: 'UsersController.create',
        module: 'UsersModule',
        inputs: [{ kind: 'body', required: true, schema: expect.objectContaining({ type: 'object', required: ['name'] }) }],
        guards: ['JwtGuard'],
        interceptors: [],
        status: 201,
        sse: false,
        returns: expect.objectContaining({ type: 'object', additionalProperties: false }),
      },
      {
        method: 'POST',
        path: '/users/avatar',
        handler: 'UsersController.avatar',
        module: 'UsersModule',
        // A File has no JSON Schema.
        inputs: [{ kind: 'form', required: true, schema: {} }],
        guards: ['JwtGuard'],
        interceptors: [],
        status: 201,
        sse: false,
      },
      { method: 'WS', path: '/chat', handler: 'ChatGateway', module: 'UsersModule', inputs: [], guards: [], interceptors: [], events: ['message'] },
    ])
  })

  it('describes an application with problems as far as it goes, and lists them', async () => {
    class Lost {}

    class NeedsLost {
      readonly lost = inject(Lost)
    }

    @Module({ providers: [NeedsLost] })
    class BrokenModule {}

    const report = await inspectApp(BrokenModule)

    expect(report.ok).toBe(false)
    expect(report.problems).toMatchObject([{ code: 'NO_PROVIDER' }])
    expect(report.modules[0]!.providers).toEqual([
      { token: 'NeedsLost', kind: 'class', scope: 'singleton', injects: [{ token: 'Lost', optional: false, from: undefined }] },
    ])
  })
})

describe('soda inspect', () => {
  const inspect = async (args: readonly string[]) => {
    await writeFile(
      join(directory, 'main.ts'),
      [
        `import { Controller, createApp, Get, inject, Module } from '${SOURCE}/index.ts'`,
        'class Service {}',
        "@Controller('/items')",
        'class ItemsController {',
        '  readonly service = inject(Service)',
        '  @Get()',
        '  list() {}',
        '}',
        '@Module({ providers: [Service], controllers: [ItemsController] })',
        'class AppModule {}',
        'await createApp(AppModule)',
      ].join('\n')
    )

    const child = Bun.spawn(['bun', join(SOURCE, 'cli', 'main.ts'), 'inspect', 'main.ts', ...args], { cwd: directory, stdout: 'pipe' })
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited])

    return { stdout, code }
  }

  it('writes the modules and the routes', async () => {
    const { stdout, code } = await inspect([])

    expect(code).toBe(0)
    expect(stdout).toContain('soda inspect  1 module · 1 provider · 1 route')
    expect(stdout).toContain('ItemsController  → Service')
    expect(stdout).toContain('GET  /items  ItemsController.list')
  })

  it('writes JSON with --json', async () => {
    const { stdout } = await inspect(['--json'])

    expect(JSON.parse(stdout)).toMatchObject({ ok: true, modules: [{ name: 'AppModule' }], routes: [{ method: 'GET', path: '/items' }] })
  })
})
