import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { ConfigModule, defineConfig } from '../config/index.ts'
import { inject, InjectionToken, Module, provide } from '../di/index.ts'
import { Controller, Get, int, param, UseGuards } from '../http/index.ts'
import type { CanActivate } from '../http/index.ts'
import { createApp } from './app.ts'
import { CHECK_HOOK, checkApp } from './check.ts'
import type { CheckHook, CheckReport } from './check.ts'

const SOURCE = join(import.meta.dir, '..')
const directory = await mkdtemp(join(tmpdir(), 'soda-check-'))

afterAll(() => rm(directory, { recursive: true, force: true }))

describe('checkApp', () => {
  it('reports every problem at once, each with where it is and how to fix it', async () => {
    const CheckedConfig = defineConfig('checked', z.object({ CHECKED_SECRET: z.string().min(32) }))

    class HiddenRepository {}
    class MissingMailer {}

    class CheckedService {
      readonly repository = inject(HiddenRepository)
      readonly mailer = inject(MissingMailer)
    }

    @Controller('/checked')
    class CheckedController {
      readonly service = inject(CheckedService)

      @Get(':id', [param('checkedId', int)])
      findOne(): void {}
    }

    @Module({ providers: [HiddenRepository] })
    class HidingModule {}

    @Module({
      imports: [HidingModule, ConfigModule.forRoot({ load: [CheckedConfig], env: {} })],
      providers: [CheckedService],
      controllers: [CheckedController],
    })
    class CheckedModule {}

    const report = await checkApp(CheckedModule)

    expect(report.ok).toBe(false)
    expect(report.problems.map(({ code, message, fix }) => ({ code, message, fix }))).toEqual([
      {
        code: 'INVALID_CONFIG',
        message: 'Invalid configuration "checked":\n  CHECKED_SECRET: Invalid input: expected string, received undefined',
        fix: 'Set the variables in the environment or in .env, as the schema of the configuration expects.',
      },
      {
        code: 'NO_PROVIDER',
        message: 'No provider for HiddenRepository in CheckedModule (CheckedService → HiddenRepository).',
        fix: 'HidingModule provides it but does not export it: add it to the exports of HidingModule.',
      },
      {
        code: 'NO_PROVIDER',
        message: 'No provider for MissingMailer in CheckedModule (CheckedService → MissingMailer).',
        fix: 'Add it to the providers of CheckedModule, or import a module that exports it.',
      },
      {
        code: 'UNKNOWN_PARAM',
        message: `CheckedController.findOne: param('checkedId') is not a parameter of "/checked/:id" (its parameters: id)`,
        fix: undefined,
      },
    ])

    const [config, repository, mailer, unknown] = report.problems

    expect(config!.file).toEndWith('src/app/check.test.ts')
    expect(repository).toMatchObject({ line: 27, column: 29 })
    expect(mailer).toMatchObject({ line: 28, column: 25 })
    expect(unknown).toMatchObject({ line: 35, column: 20 })
  })

  it('creates classes but calls no factory, runs no hook and listens nowhere', async () => {
    const events: string[] = []
    const CONNECTION = new InjectionToken<{ query: () => string }>('CONNECTION')

    class Repository {
      readonly connection = inject(CONNECTION)
      readonly table = `${this.connection.query()}`

      constructor() {
        events.push('constructed')
      }

      onInit(): void {
        events.push('onInit')
      }
    }

    class Guard implements CanActivate {
      readonly repository = inject(Repository)

      canActivate(): boolean {
        return true
      }
    }

    @Controller('/items')
    @UseGuards(Guard)
    class ItemsController {
      @Get()
      list(): void {}
    }

    @Module({
      providers: [
        Repository,
        provide(CONNECTION, {
          useFactory: () => {
            events.push('connected')

            return { query: () => 'items' }
          },
        }),
      ],
      controllers: [ItemsController],
    })
    class ItemsModule {}

    const report = await checkApp(ItemsModule)

    expect(report).toMatchObject({ ok: true, problems: [], modules: 1, providers: 2, routes: 1 })
    expect(events).toEqual(['constructed'])
  })

  it('reports what a class throws on its own', async () => {
    class Broken {
      constructor() {
        throw new TypeError('broken on purpose')
      }
    }

    @Module({ providers: [Broken] })
    class BrokenModule {}

    const report = await checkApp(BrokenModule)

    // Its place comes from the stack (as for the entry below), but here the class is in the framework's own files.
    expect(report.problems).toMatchObject([{ code: 'FAILED', message: 'TypeError: broken on purpose' }])
  })

  it('makes createApp() hand the report over instead of starting', async () => {
    @Module({})
    class EmptyModule {}

    const globals = globalThis as Record<symbol, CheckHook | undefined>
    const { promise, resolve } = Promise.withResolvers<CheckReport>()

    globals[CHECK_HOOK] = (report) => {
      void report.then(resolve)
    }

    try {
      void createApp(EmptyModule)
      expect(await promise).toMatchObject({ ok: true, modules: 1 })
    } finally {
      globals[CHECK_HOOK] = undefined
    }
  })
})

describe('soda check', () => {
  const check = async (main: string, args: readonly string[] = []) => {
    await writeFile(join(directory, 'main.ts'), main)

    const child = Bun.spawn(['bun', join(SOURCE, 'cli', 'main.ts'), 'check', 'main.ts', ...args], { cwd: directory, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited])

    return { stdout, code }
  }

  it('writes the problems with the line of code and exits with 1', async () => {
    const { stdout, code } = await check(
      [
        `import { createApp, inject, Module } from '${SOURCE}/index.ts'`,
        'class Missing {}',
        'class Service {',
        '  readonly missing = inject(Missing)',
        '}',
        '@Module({ providers: [Service] })',
        'class AppModule {}',
        'const app = await createApp(AppModule)',
        'await app.listen(3000)',
      ].join('\n')
    )

    expect(code).toBe(1)
    expect(stdout).toContain('soda check  1 problem')
    expect(stdout).toContain('✖ NO_PROVIDER  No provider for Missing in AppModule (Service → Missing).')
    expect(stdout).toContain('main.ts:4:22')
    expect(stdout).toContain('4 │   readonly missing = inject(Missing)')
    expect(stdout).toContain('fix  Add it to the providers of AppModule, or import a module that exports it.')
  })

  it('writes JSON with --json, and exits with 0 when all is well', async () => {
    const { stdout, code } = await check(
      [`import { createApp, Module } from '${SOURCE}/index.ts'`, '@Module({})', 'class AppModule {}', 'await createApp(AppModule)'].join('\n'),
      ['--json']
    )

    expect(code).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, problems: [], modules: 1 })
  })

  it('reports an entry that fails or never creates the application', async () => {
    const failing = await check(`throw new Error('top-level failure')`, ['--json'])
    const idle = await check(`export const nothing = 1`, ['--json'])

    expect(failing.code).toBe(1)
    expect(JSON.parse(failing.stdout).problems).toMatchObject([{ code: 'FAILED', message: 'Error: top-level failure', file: 'main.ts', line: 1 }])
    expect(idle.code).toBe(1)
    expect(JSON.parse(idle.stdout).problems[0].message).toContain('did not call createApp()')
  })
})
