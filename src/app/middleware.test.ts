import { afterAll, describe, expect, it } from 'bun:test'
import { inject, Module } from '../di/index.ts'
import type { ModuleClass, OnDestroy, OnInit } from '../di/index.ts'
import { Controller, cors, Get, Options } from '../http/index.ts'
import type { Middleware, NestMiddleware, Next } from '../http/index.ts'
import { createApp } from './app.ts'
import type { App, AppOptions } from './app.ts'

const apps: App[] = []

afterAll(async () => {
  for (const app of apps) {
    await app.close()
  }
})

@Controller('/items')
class ItemsController {
  @Get()
  list(): string[] {
    return ['a']
  }

  @Options('/custom')
  custom(): string {
    return 'own OPTIONS route'
  }
}

@Module({ controllers: [ItemsController] })
class ItemsModule {}

const start = async (options: AppOptions, module: ModuleClass = ItemsModule) => {
  const app = await createApp(module, options)
  const server = await app.listen(0)

  apps.push(app)

  return (path: string, init: RequestInit = {}) => fetch(server.url.origin + path, init)
}

describe('middleware', () => {
  it('runs around every request, first outermost, including 404 and 405', async () => {
    const order: string[] = []

    const trace =
      (name: string): Middleware =>
      async (_req, next) => {
        order.push(`${name} before`)

        const response = await next()

        order.push(`${name} after ${response.status}`)

        return response
      }

    const request = await start({ middleware: [trace('outer'), trace('inner')] })

    await request('/items')
    await request('/missing')
    await request('/items', { method: 'DELETE' })

    expect(order).toEqual([
      'outer before',
      'inner before',
      'inner after 200',
      'outer after 200',
      'outer before',
      'inner before',
      'inner after 404',
      'outer after 404',
      'outer before',
      'inner before',
      'inner after 405',
      'outer after 405',
    ])
  })

  it('may answer without reaching the route, and errors become a 500', async () => {
    const logged: unknown[] = []
    const request = await start({
      middleware: [
        (req, next) => (req.headers.has('x-maintenance') ? new Response('maintenance', { status: 503 }) : next()),
        (req, next) => {
          if (req.headers.has('x-crash')) {
            throw new Error('middleware bug')
          }

          return next()
        },
      ],
      onError: (error) => logged.push(error),
    })
    const blocked = await request('/items', { headers: { 'x-maintenance': '1' } })
    const crashed = await request('/items', { headers: { 'x-crash': '1' } })

    expect([blocked.status, await blocked.text()]).toEqual([503, 'maintenance'])
    expect([crashed.status, await crashed.json()]).toEqual([500, { statusCode: 500, message: 'Internal server error' }])
    expect((logged[0] as Error).message).toBe('middleware bug')
  })

  it('creates middleware classes in the root module, with lifecycle hooks', async () => {
    const log: string[] = []

    class Clock {
      now(): string {
        return 'now'
      }
    }

    class Stamp implements NestMiddleware, OnInit, OnDestroy {
      readonly #clock = inject(Clock)

      onInit(): void {
        log.push('init')
      }

      onDestroy(): void {
        log.push('destroy')
      }

      async use(_req: Request, next: Next): Promise<Response> {
        const response = await next()

        response.headers.set('x-stamp', this.#clock.now())

        return response
      }
    }

    @Module({ imports: [ItemsModule], providers: [Clock] })
    class AppModule {}

    const app = await createApp(AppModule, { middleware: [Stamp] })
    const server = await app.listen(0)

    expect((await fetch(`${server.url.origin}/items`)).headers.get('x-stamp')).toBe('now')
    await app.close()
    expect(log).toEqual(['init', 'destroy'])
  })
})

describe('cors', () => {
  const ORIGIN = 'https://app.example.com'

  it('echoes an allowed origin and varies on Origin', async () => {
    const request = await start({ middleware: [cors({ origin: [ORIGIN], exposedHeaders: ['x-total'] })] })
    const allowed = await request('/items', { headers: { origin: ORIGIN } })
    const refused = await request('/items', { headers: { origin: 'https://evil.example' } })

    expect([allowed.headers.get('access-control-allow-origin'), allowed.headers.get('vary')]).toEqual([ORIGIN, 'Origin'])
    expect(allowed.headers.get('access-control-expose-headers')).toBe('x-total')
    expect([refused.status, refused.headers.get('access-control-allow-origin'), refused.headers.get('vary')]).toEqual([
      200,
      null,
      'Origin',
    ])
  })

  it('answers preflights before routing, even for paths with no OPTIONS route', async () => {
    const request = await start({ middleware: [cors({ origin: ORIGIN, credentials: true, maxAge: 600 })] })
    const preflight = await request('/items', {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, x-token' },
    })

    expect(preflight.status).toBe(204)
    expect(Object.fromEntries(preflight.headers)).toMatchObject({
      'access-control-allow-origin': ORIGIN,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET, HEAD, PUT, PATCH, POST, DELETE',
      'access-control-allow-headers': 'content-type, x-token',
      'access-control-max-age': '600',
      vary: 'Origin, Access-Control-Request-Headers',
    })

    const refused = await request('/items', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    })

    expect([refused.status, refused.headers.get('access-control-allow-origin')]).toEqual([204, null])
  })

  it('lets OPTIONS requests that are not preflights reach the application', async () => {
    const request = await start({ middleware: [cors()] })
    const own = await request('/items/custom', { method: 'OPTIONS', headers: { origin: ORIGIN } })

    expect([own.status, await own.text(), own.headers.get('access-control-allow-origin')]).toEqual([
      200,
      'own OPTIONS route',
      '*',
    ])
  })

  it('adds headers to responses of unknown paths', async () => {
    const request = await start({ middleware: [cors()] })
    const missing = await request('/missing', { headers: { origin: ORIGIN } })

    expect([missing.status, missing.headers.get('access-control-allow-origin')]).toEqual([404, '*'])
  })

  it("refuses credentials with origin '*', which browsers reject", () => {
    expect(() => cors({ credentials: true })).toThrow("credentials cannot be used with origin '*'")
  })
})
