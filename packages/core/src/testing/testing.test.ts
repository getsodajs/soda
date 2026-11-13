import { describe, expect, it } from 'bun:test'
import { inject, InjectionToken, Module, provide } from '../di/index.ts'
import { body } from '../http/arguments.ts'
import { Controller, Get, Post } from '../http/decorators.ts'
import { createTestApp } from './index.ts'

const GREETING = new InjectionToken<string>('GREETING')

@Controller('greet')
class GreetController {
  readonly #greeting = inject(GREETING)

  @Get()
  greet(): string {
    return this.#greeting
  }

  @Post([body()])
  echo(value: unknown): unknown {
    return value
  }
}

@Module({ providers: [provide(GREETING, { useValue: 'Hello' })], controllers: [GreetController] })
class AppModule {}

describe('createTestApp', () => {
  it('serves the application on a free port, with overrides, and sends JSON', async () => {
    const app = await createTestApp(AppModule, { overrides: [provide(GREETING, { useValue: 'Hi' })] })

    try {
      const echoed = await app.request('/greet', { method: 'POST', json: { a: 1 }, headers: { 'x-test': '1' } })

      expect(app.url.hostname).toBe('127.0.0.1')
      expect(await (await app.request('/greet')).text()).toBe('Hi')
      expect(app.get(GREETING)).toBe('Hi')
      expect([echoed.status, await echoed.json()]).toEqual([201, { a: 1 }])
    } finally {
      await app.close()
    }
  })

  it('closes at the end of an await using block', async () => {
    let url: URL

    {
      await using app = await createTestApp(AppModule)

      url = app.url
      expect((await fetch(new URL('/greet', url))).status).toBe(200)
    }

    await expect(fetch(new URL('/greet', url))).rejects.toThrow()
  })
})
