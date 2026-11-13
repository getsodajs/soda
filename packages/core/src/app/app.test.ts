import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inject, Module } from '../di/index.ts'
import type { OnDestroy, OnInit } from '../di/index.ts'
import { Controller, Get, Post, UseGuards } from '../http/index.ts'
import type { CanActivate } from '../http/index.ts'
import { Logger } from '../logger/index.ts'
import type { LogEntry } from '../logger/index.ts'
import { createApp } from './app.ts'

const SOURCE = join(import.meta.dir, '..')
const directory = await mkdtemp(join(tmpdir(), 'soda-app-'))

afterAll(() => rm(directory, { recursive: true, force: true }))

describe('lifecycle', () => {
  it('initializes guards before serving and destroys them before the services they use', async () => {
    const log: string[] = []

    class Sessions implements OnDestroy {
      onDestroy(): void {
        log.push('sessions destroyed')
      }
    }

    class SessionGuard implements CanActivate, OnInit, OnDestroy {
      readonly #sessions = inject(Sessions)
      #ready = false

      onInit(): void {
        this.#ready = true
        log.push('guard initialized')
      }

      onDestroy(): void {
        log.push('guard destroyed')
      }

      canActivate(): boolean {
        return this.#ready && this.#sessions instanceof Sessions
      }
    }

    @Controller('/me')
    @UseGuards(SessionGuard)
    class MeController {
      @Get()
      me(): string {
        return 'me'
      }
    }

    @Module({ providers: [Sessions], controllers: [MeController] })
    class AppModule {}

    const app = await createApp(AppModule, { logger: false })
    const server = await app.listen(0)

    expect(log).toEqual(['guard initialized'])
    expect(await (await fetch(`${server.url.origin}/me`)).text()).toBe('me')

    await app.close()

    expect(log).toEqual(['guard initialized', 'guard destroyed', 'sessions destroyed'])
  })

  it('rolls back and rethrows when a guard fails to initialize', async () => {
    const log: string[] = []

    class Pool implements OnDestroy {
      onDestroy(): void {
        log.push('pool closed')
      }
    }

    class BrokenGuard implements CanActivate, OnInit {
      readonly pool = inject(Pool)

      onInit(): void {
        throw new Error('cannot load keys')
      }

      canActivate(): boolean {
        return true
      }
    }

    @Controller()
    @UseGuards(BrokenGuard)
    class RootController {
      @Get()
      root(): string {
        return ''
      }
    }

    @Module({ providers: [Pool], controllers: [RootController] })
    class AppModule {}

    await expect(createApp(AppModule, { logger: false })).rejects.toThrow('cannot load keys')
    expect(log).toEqual(['pool closed'])
  })
})

describe('graceful shutdown', () => {
  it('refuses new requests, finishes those in flight, then destroys services', async () => {
    const log: string[] = []

    class Database implements OnDestroy {
      onDestroy(): void {
        log.push('database closed')
      }
    }

    @Controller()
    class SlowController {
      readonly #db = inject(Database)

      @Get('/slow')
      async slow(): Promise<string> {
        await Bun.sleep(100)
        log.push('request done')

        return this.#db instanceof Database ? 'done' : 'broken'
      }
    }

    @Module({ providers: [Database], controllers: [SlowController] })
    class AppModule {}

    const app = await createApp(AppModule, { logger: false })
    const server = await app.listen(0)
    const origin = server.url.origin
    const inFlight = fetch(`${origin}/slow`).then((response) => response.text())

    await Bun.sleep(20)

    const closing = app.close()
    const late = await fetch(`${origin}/slow`).then(
      () => 'accepted',
      () => 'refused'
    )

    expect(await inFlight).toBe('done')
    await closing
    expect(late).toBe('refused')
    expect(log).toEqual(['request done', 'database closed'])
    expect(app.close()).toBe(closing)
  })
})

/**
 * Runs `source` as a script in a separate Bun process (`args` go to `bun`) and
 * collects its stdout, which can be awaited line by line.
 */
const spawnScript = async (name: string, source: string, args: readonly string[] = []) => {
  const file = join(directory, name)

  await Bun.write(file, source)

  const child = Bun.spawn(['bun', ...args, file], { stdout: 'pipe', stderr: 'inherit' })
  let output = ''
  const waiters: (() => void)[] = []
  const done = (async () => {
    const decoder = new TextDecoder()

    for await (const chunk of child.stdout) {
      output += decoder.decode(chunk, { stream: true })

      for (const wake of waiters.splice(0)) {
        wake()
      }
    }
  })()

  /** Resolves with the output once it contains `line`; rejects if the process ends first. */
  const waitFor = async (line: string): Promise<string> => {
    if (output.includes(line)) {
      return output
    }

    const chunk = Promise.withResolvers<void>()

    waiters.push(chunk.resolve)

    const ended = await Promise.race([chunk.promise.then(() => false), done.then(() => true)])

    if (ended && !output.includes(line)) {
      throw new Error(`Process ended before printing "${line}":\n${output}`)
    }

    return waitFor(line)
  }

  /** Whole output, once the process closed its stdout. */
  const fullOutput = async (): Promise<string> => {
    await done

    return output
  }

  return { file, child, waitFor, fullOutput }
}

const APP_SOURCE = (version: string, port: number, extra = '') => `
import { createApp } from '${SOURCE}/app'
import { Module } from '${SOURCE}/di'
import { Controller, Get } from '${SOURCE}/http'

class Clock {
  readonly #timer = setInterval(() => {}, 1000)

  onDestroy() {
    clearInterval(this.#timer)
    console.log('destroyed ${version}')
  }
}

@Controller()
class VersionController {
  @Get()
  version() {
    return '${version}'
  }
}

@Module({ providers: [Clock], controllers: [VersionController] })
class AppModule {}

const app = await createApp(AppModule)

await app.listen(${port})
${extra}
console.log('listening ${version}')
`

describe('shutdown signals', () => {
  it('closes the application on SIGTERM, then lets the signal end the process', async () => {
    const { child, waitFor, fullOutput } = await spawnScript('signal.ts', APP_SOURCE('v1', 0, 'app.enableShutdownSignals()'))

    await waitFor('listening v1')
    child.kill('SIGTERM')
    await child.exited

    expect(child.signalCode).toBe('SIGTERM')
    expect(await fullOutput()).toContain('destroyed v1')
  })

  it('gives signals back their default behaviour after a manual close()', async () => {
    const { child, waitFor } = await spawnScript(
      'closed.ts',
      APP_SOURCE('v1', 0, 'app.enableShutdownSignals()\nawait app.close()\nsetInterval(() => {}, 1000)')
    )

    await waitFor('listening v1')
    child.kill('SIGINT')

    await child.exited
    expect(child.signalCode).toBe('SIGINT')
  })
})

describe('hot reload', () => {
  it('destroys the previous version and serves the new one on the same port', async () => {
    const port = 40000 + Math.floor(Math.random() * 20000)
    const { file, child, waitFor } = await spawnScript('hot.ts', APP_SOURCE('v1', port), ['--hot'])

    try {
      await waitFor('listening v1')
      expect(await (await fetch(`http://localhost:${port}/`)).text()).toBe('v1')

      await Bun.write(file, APP_SOURCE('v2', port))

      const output = await waitFor('listening v2')

      expect(output).toContain('destroyed v1')
      expect(await (await fetch(`http://localhost:${port}/`)).text()).toBe('v2')
    } finally {
      child.kill()
      await child.exited
    }
  })
})

describe('request body limit', () => {
  it('refuses bodies over maxRequestBodySize before any handler runs', async () => {
    let calls = 0

    @Controller('/upload')
    class UploadController {
      @Post()
      upload(): string {
        calls++

        return 'stored'
      }
    }

    @Module({ controllers: [UploadController] })
    class AppModule {}

    const app = await createApp(AppModule, { logger: false })
    const server = await app.listen({ port: 0, maxRequestBodySize: 1024 })
    const small = await fetch(`${server.url.origin}/upload`, { method: 'POST', body: 'x'.repeat(100) })
    const large = await fetch(`${server.url.origin}/upload`, { method: 'POST', body: 'x'.repeat(10_000) })

    await app.close()

    expect(small.status).toBe(201)
    expect(large.status).toBe(413)
    expect(calls).toBe(1)
  })
})

describe('logger', () => {
  /** A logger keeping its entries. */
  class MemoryLogger extends Logger {
    readonly entries: LogEntry[] = []

    write(entry: LogEntry): void {
      this.entries.push(entry)
    }
  }

  it('logs the startup, is injectable everywhere and receives unhandled errors with the request', async () => {
    const logger = new MemoryLogger()

    class Reporter {
      readonly logger = inject(Logger)
    }

    @Controller('/fail')
    class FailingController {
      @Get()
      fail(): never {
        throw new Error('broken')
      }
    }

    @Module({ providers: [Reporter], exports: [Reporter] })
    class ReportingModule {}

    @Module({ imports: [ReportingModule], controllers: [FailingController] })
    class AppModule {}

    const app = await createApp(AppModule, { logger })
    const server = await app.listen(0)

    expect(app.container.get(Reporter).logger).toBe(logger)

    await fetch(`${server.url.origin}/fail`)
    await app.close()

    const failure = logger.entries.at(-1)!

    expect(logger.entries.map(({ level, context, message }) => `${level} [${context}] ${message}`)).toEqual([
      'log [Soda] Starting application',
      'log [Container] ReportingModule dependencies initialized',
      'log [Container] AppModule dependencies initialized',
      'log [Routes] FailingController {/fail}:',
      'log [Routes] Mapped {/fail, GET} route',
      'log [Soda] Application started',
      `log [Soda] Listening on ${server.url.href}`,
      'error [Soda] Unhandled error while handling a request',
    ])
    expect(failure.data).toMatchObject({ method: 'GET', url: `${server.url.origin}/fail` })
    expect((failure.data!.error as Error).message).toBe('broken')
  })
})
