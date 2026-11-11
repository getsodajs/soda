import { afterAll, describe, expect, it } from 'bun:test'
import { createContainer, inject, Module } from '../di'
import type { ModuleClass } from '../di'
import { compileRoutes } from '../routing'
import { param } from './arguments'
import type { Context } from './context'
import { Controller, Get } from './decorators'
import { Catch, createDecorator, UseFilters, UseGuards, UseInterceptors } from './enhancers'
import type { CanActivate, ExceptionFilter, Interceptor } from './enhancers'
import { HttpException, NotFoundException, UnauthorizedException } from './exceptions'
import { int } from './parsers'
import { controllerRoutes } from './routes'
import type { ControllerRoutesOptions } from './routes'

const server = Bun.serve({ port: 0, routes: {}, fetch: () => new Response(null, { status: 404 }) })

afterAll(() => server.stop(true))

const serve = async (module: ModuleClass, options?: ControllerRoutesOptions) => {
  const container = await createContainer(module)

  server.reload(compileRoutes(controllerRoutes(container, options)))

  return (path: string, headers: Record<string, string> = {}) => fetch(server.url.origin + path, { headers })
}

const Roles = createDecorator<readonly string[]>('Roles')

describe('guards', () => {
  it('runs global, class and method guards in that order, and stops at the first refusal', async () => {
    const order: string[] = []

    const allow = (name: string) => () => {
      order.push(name)

      return true
    }

    @Controller('/g')
    @UseGuards(allow('class'))
    class GuardedController {
      @Get()
      @UseGuards(allow('method 1'), allow('method 2'))
      open(): string {
        return 'open'
      }

      @Get('/closed')
      @UseGuards(() => false, allow('never'))
      closed(): string {
        return 'unreachable'
      }
    }

    @Module({ controllers: [GuardedController] })
    class AppModule {}

    const request = await serve(AppModule, { guards: [allow('global')] })

    expect(await (await request('/g')).text()).toBe('open')
    expect(order).toEqual(['global', 'class', 'method 1', 'method 2'])

    order.length = 0

    const closed = await request('/g/closed')

    expect([closed.status, await closed.json()]).toEqual([
      403,
      { statusCode: 403, message: 'Forbidden resource', error: 'Forbidden' },
    ])
    expect(order).toEqual(['global', 'class'])
  })

  it('creates guard classes in the controller module and runs guard functions there', async () => {
    class Tokens {
      valid(token: string | null): boolean {
        return token === 'secret'
      }
    }

    class AuthGuard implements CanActivate {
      readonly #tokens = inject(Tokens)

      async canActivate(ctx: Context): Promise<boolean> {
        await Bun.sleep(1)

        return this.#tokens.valid(ctx.req.headers.get('authorization'))
      }
    }

    const roleGuard = (ctx: Context): boolean => {
      const roles = ctx.metadata(Roles) ?? []

      return roles.length === 0 || inject(Tokens).valid(ctx.req.headers.get('authorization'))
    }

    @Controller('/a')
    @UseGuards(AuthGuard)
    @Roles(['user'])
    class AccountController {
      @Get()
      @UseGuards(roleGuard)
      @Roles([])
      me(ctx: Context): string {
        return ctx.metadata(Roles)?.join(',') ?? 'none'
      }
    }

    // Tokens is private to the module: only something created there can inject it.
    @Module({ providers: [Tokens], controllers: [AccountController] })
    class AccountModule {}

    @Module({ imports: [AccountModule] })
    class AppModule {}

    const request = await serve(AppModule)

    expect((await request('/a')).status).toBe(403)
    expect([(await request('/a', { authorization: 'secret' })).status, await (await request('/a', { authorization: 'secret' })).text()]).toEqual([
      200,
      '',
    ])
  })

  it('lets a guard answer with its own exception', async () => {
    @Controller('/u')
    class StrictController {
      @Get()
      @UseGuards(() => {
        throw new UnauthorizedException('Token expired')
      })
      read(): string {
        return 'unreachable'
      }
    }

    @Module({ controllers: [StrictController] })
    class AppModule {}

    const response = await (await serve(AppModule))('/u')

    expect([response.status, (await response.json() as { message: string }).message]).toEqual([401, 'Token expired'])
  })

  it('extends the guards of a parent controller', async () => {
    const order: string[] = []

    @UseGuards(() => {
      order.push('parent')

      return true
    })
    class BaseController {}

    @Controller('/child')
    @UseGuards(() => {
      order.push('child')

      return true
    })
    class ChildController extends BaseController {
      @Get()
      read(): string {
        return 'ok'
      }
    }

    @Module({ controllers: [ChildController] })
    class AppModule {}

    await (await serve(AppModule))('/child')

    expect(order).toEqual(['parent', 'child'])
  })
})

describe('interceptors', () => {
  it('wraps the handler, outermost first, and may map the result', async () => {
    const order: string[] = []

    class Envelope implements Interceptor {
      async intercept(_ctx: Context, next: () => Promise<unknown>): Promise<unknown> {
        order.push('envelope before')

        const data = await next()

        order.push('envelope after')

        return { data }
      }
    }

    @Controller('/i')
    @UseInterceptors(Envelope)
    class WrappedController {
      @Get(':id', [param('id', int())])
      @UseInterceptors(async (_ctx, next) => {
        order.push('method before')

        const value = await next()

        order.push('method after')

        return value
      })
      read(id: number): object {
        order.push('handler')

        return { id }
      }
    }

    @Module({ controllers: [WrappedController] })
    class AppModule {}

    const request = await serve(AppModule, {
      interceptors: [
        async (_ctx, next) => {
          order.push('global before')

          const value = await next()

          order.push('global after')

          return value
        },
      ],
    })

    expect(await (await request('/i/3')).json()).toEqual({ data: { id: 3 } })
    expect(order).toEqual([
      'global before',
      'envelope before',
      'method before',
      'handler',
      'method after',
      'envelope after',
      'global after',
    ])
  })

  it('may answer instead of the handler, as a cache does', async () => {
    let calls = 0
    const cache = new Map<string, unknown>()

    @Controller('/c')
    class CachedController {
      @Get()
      @UseInterceptors(async (ctx, next) => {
        const key = ctx.req.url

        if (!cache.has(key)) {
          cache.set(key, await next())
        }

        return cache.get(key)
      })
      read(): object {
        calls++

        return { calls }
      }
    }

    @Module({ controllers: [CachedController] })
    class AppModule {}

    const request = await serve(AppModule)

    expect(await (await request('/c')).json()).toEqual({ calls: 1 })
    expect(await (await request('/c')).json()).toEqual({ calls: 1 })
    expect(calls).toBe(1)
  })
})

describe('exception filters', () => {
  class DomainError extends Error {}

  @Catch(DomainError)
  class DomainFilter implements ExceptionFilter<DomainError> {
    catch(error: DomainError): Response {
      return Response.json({ domain: error.message }, { status: 409 })
    }
  }

  @Catch(HttpException)
  class HttpFilter implements ExceptionFilter<HttpException> {
    catch(error: HttpException, ctx: Context): Response {
      return Response.json({ http: error.status, route: `${ctx.route.controller.name}.${ctx.route.handler}` }, { status: error.status })
    }
  }

  it('tries method, class and global filters in that order, by caught type', async () => {
    @Controller('/f')
    @UseFilters(HttpFilter)
    class FailingController {
      @Get('/domain')
      @UseFilters(new DomainFilter())
      domain(): never {
        throw new DomainError('conflict')
      }

      @Get('/missing')
      @UseFilters(DomainFilter)
      missing(): never {
        throw new NotFoundException()
      }

      @Get('/other')
      other(): never {
        throw new TypeError('bug')
      }
    }

    @Module({ controllers: [FailingController] })
    class AppModule {}

    const request = await serve(AppModule, {
      filters: [(error) => Response.json({ global: (error as Error).name }, { status: 500 })],
    })

    expect(await (await request('/f/domain')).json()).toEqual({ domain: 'conflict' })
    expect(await (await request('/f/missing')).json()).toEqual({ http: 404, route: 'FailingController.missing' })
    expect(await (await request('/f/other')).json()).toEqual({ global: 'TypeError' })
  })

  it('catches errors of guards and of argument reading too', async () => {
    @Controller('/g')
    @UseFilters(HttpFilter)
    class CheckedController {
      @Get('/denied')
      @UseGuards(() => false)
      denied(): string {
        return ''
      }

      @Get('/n/:id', [param('id', int())])
      number(id: number): number {
        return id
      }
    }

    @Module({ controllers: [CheckedController] })
    class AppModule {}

    const request = await serve(AppModule)

    expect((await (await request('/g/denied')).json() as { http: number }).http).toBe(403)
    expect((await (await request('/g/n/x')).json() as { http: number }).http).toBe(400)
  })

  it('falls back to the base handler when a filter fails', async () => {
    const logged: unknown[] = []

    @Controller('/b')
    class BrokenFilterController {
      @Get()
      @UseFilters(() => {
        throw new Error('filter bug')
      })
      read(): never {
        throw new Error('handler bug')
      }
    }

    @Module({ controllers: [BrokenFilterController] })
    class AppModule {}

    const response = await (await serve(AppModule, { onError: (error) => logged.push(error) }))('/b')

    expect([response.status, await response.json()]).toEqual([500, { statusCode: 500, message: 'Internal server error' }])
    expect((logged[0] as Error).message).toBe('filter bug')
  })
})

describe('fast path', () => {
  it('answers synchronously when nothing in the route is asynchronous', async () => {
    @Controller('/s')
    class SyncController {
      @Get()
      @UseGuards(() => true)
      read(): string {
        return 'sync'
      }
    }

    @Module({ controllers: [SyncController] })
    class AppModule {}

    const [route] = controllerRoutes(await createContainer(AppModule))
    const result = route!.handler(new Request('http://localhost/s'), {})

    expect(result).toBeInstanceOf(Response)
  })
})
