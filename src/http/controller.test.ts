import { afterAll, describe, expect, it } from 'bun:test'
import { createContainer, inject, Module } from '../di'
import type { ModuleClass } from '../di'
import { compileRoutes, RouteError } from '../routing'
import { body, context, header, param, query } from './arguments'
import type { Context } from './context'
import { All, Controller, Delete, Get, Header, HttpCode, Patch, Post, Route } from './decorators'
import { ControllerError } from './errors'
import { HttpException, NotFoundException } from './exceptions'
import { int } from './parsers'
import { controllerRoutes } from './routes'
import type { ControllerRoutesOptions } from './routes'
import type { StandardSchemaV1 } from './schema'

const server = Bun.serve({ port: 0, routes: {}, fetch: () => new Response(null, { status: 404 }) })

afterAll(() => server.stop(true))

/** Starts `module` on the shared server and returns a request function. */
const serve = async (module: ModuleClass, options?: ControllerRoutesOptions) => {
  const container = await createContainer(module)

  server.reload(compileRoutes(controllerRoutes(container, options)))

  return (method: string, path: string, init: RequestInit = {}) => fetch(server.url.origin + path, { ...init, method })
}

const json = (value: unknown): RequestInit => ({
  body: JSON.stringify(value),
  headers: { 'content-type': 'application/json' },
})

interface User {
  readonly name: string
  readonly age: number
}

/** Minimal Standard Schema, enough to exercise the integration without a schema library. */
const UserSchema: StandardSchemaV1<unknown, User> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) => {
      const issues: StandardSchemaV1.Issue[] = []
      const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>

      if (typeof record.name !== 'string') {
        issues.push({ message: 'Expected a string', path: ['name'] })
      }

      if (typeof record.age !== 'number') {
        issues.push({ message: 'Expected a number', path: [{ key: 'age' }] })
      }

      return issues.length > 0 ? { issues } : { value: { name: record.name as string, age: record.age as number } }
    },
  },
}

describe('routes', () => {
  it('joins the prefix, controller and method paths like Nest', async () => {
    @Controller('users/')
    class UsersController {
      @Get()
      list(): string {
        return 'list'
      }

      @Get(':id')
      one(ctx: Context<':id'>): string {
        return `user ${ctx.param('id')}`
      }
    }

    @Controller()
    class RootController {
      @Get('/')
      root(): string {
        return 'root'
      }
    }

    @Module({ controllers: [UsersController, RootController] })
    class AppModule {}

    const request = await serve(AppModule, { prefix: '/api/' })

    expect(await (await request('GET', '/api/users')).text()).toBe('list')
    expect(await (await request('GET', '/api/users/7')).text()).toBe('user 7')
    expect(await (await request('GET', '/api')).text()).toBe('root')
  })

  it('serves several routes from one method, and any method with @Route() or @All()', async () => {
    @Controller('/docs')
    class DocsController {
      @Get('/latest')
      @Get('/v/:version')
      read(ctx: Context): string {
        return ctx.param('version') ?? 'latest'
      }

      @Route('PROPFIND', '/')
      properties(): string {
        return 'propfind'
      }

      @All('/any')
      any(ctx: Context): string {
        return ctx.req.method
      }
    }

    @Module({ controllers: [DocsController] })
    class AppModule {}

    const request = await serve(AppModule)

    expect(await (await request('GET', '/docs/latest')).text()).toBe('latest')
    expect(await (await request('GET', '/docs/v/2')).text()).toBe('2')
    expect(await (await request('PROPFIND', '/docs')).text()).toBe('propfind')
    expect(await (await request('PATCH', '/docs/any')).text()).toBe('PATCH')
  })

  it('injects dependencies into controllers', async () => {
    class Greeter {
      greet(name: string): string {
        return `hello ${name}`
      }
    }

    @Controller('/greet')
    class GreetController {
      readonly #greeter = inject(Greeter)

      @Get()
      greet(ctx: Context): string {
        return this.#greeter.greet(ctx.query('name') ?? 'nobody')
      }
    }

    @Module({ providers: [Greeter], controllers: [GreetController] })
    class AppModule {}

    const request = await serve(AppModule)

    expect(await (await request('GET', '/greet?name=soda')).text()).toBe('hello soda')
  })

  it('inherits routes, and drops a route overridden without a decorator', async () => {
    @Controller('/base')
    class BaseController {
      @Get('/kept')
      kept(): string {
        return 'kept'
      }

      @Get('/dropped')
      dropped(): string {
        return 'dropped'
      }
    }

    @Controller('/child')
    class ChildController extends BaseController {
      override dropped(): string {
        return 'not a route'
      }
    }

    @Module({ controllers: [ChildController] })
    class AppModule {}

    const request = await serve(AppModule)

    expect(await (await request('GET', '/child/kept')).text()).toBe('kept')
    expect((await request('GET', '/child/dropped')).status).toBe(404)
  })

  it('names conflicting handlers in the startup error', async () => {
    @Controller('/a')
    class FirstController {
      @Get(':id')
      first(): string {
        return ''
      }
    }

    @Controller('/a')
    class SecondController {
      @Get(':key')
      second(): string {
        return ''
      }
    }

    @Module({ controllers: [FirstController, SecondController] })
    class AppModule {}

    const container = await createContainer(AppModule)
    const routes = controllerRoutes(container)

    expect(() => compileRoutes(routes)).toThrow(RouteError)
    expect(() => compileRoutes(routes)).toThrow(
      /GET "\/a\/:key" \(SecondController\.second\) conflicts with GET "\/a\/:id" \(FirstController\.first\)/
    )
  })
})

describe('arguments', () => {
  @Controller('/users')
  class UsersController {
    @Get(':id', [param('id', int())])
    findOne(id: number): object {
      return { id }
    }

    @Get([query('page', int({ optional: true })), header('accept-language')])
    list(page: number | undefined, language: string | undefined): object {
      return { page: page ?? 1, language: language ?? null }
    }

    @Post([body(UserSchema)])
    create(user: User): User {
      return user
    }

    @Patch(':id', [param('id', int()), body(UserSchema), context()])
    update(id: number, user: User, ctx: Context): object {
      return { id, user, method: ctx.req.method }
    }

    @Patch(':id/name')
    async rename(ctx: Context<':id/name'>): Promise<object> {
      const id = ctx.param('id', int())
      const user = await ctx.body(UserSchema)

      return { id, name: user.name }
    }
  }

  @Module({ controllers: [UsersController] })
  class AppModule {}

  it('passes declared arguments, converted and validated', async () => {
    const request = await serve(AppModule)

    expect(await (await request('GET', '/users/7')).json()).toEqual({ id: 7 })
    expect(await (await request('GET', '/users?page=3', { headers: { 'accept-language': 'ru' } })).json()).toEqual({
      page: 3,
      language: 'ru',
    })
    expect(await (await request('GET', '/users')).json()).toEqual({ page: 1, language: null })
    expect(await (await request('POST', '/users', json({ name: 'Ann', age: 30 }))).json()).toEqual({ name: 'Ann', age: 30 })
    expect(await (await request('PATCH', '/users/2', json({ name: 'Bo', age: 4 }))).json()).toEqual({
      id: 2,
      user: { name: 'Bo', age: 4 },
      method: 'PATCH',
    })
  })

  it('reads the same values from the context', async () => {
    const request = await serve(AppModule)

    expect(await (await request('PATCH', '/users/5/name', json({ name: 'Cy', age: 1 }))).json()).toEqual({ id: 5, name: 'Cy' })
  })

  it('answers 400 with Nest-style bodies for invalid values', async () => {
    const request = await serve(AppModule)
    const notInteger = await request('GET', '/users/abc')
    const unsafe = await request('GET', '/users/99999999999999999999')
    const invalid = await request('POST', '/users', json({ name: 1 }))

    expect([notInteger.status, await notInteger.json()]).toEqual([
      400,
      { statusCode: 400, message: 'Validation failed for "id" (integer string is expected)', error: 'Bad Request' },
    ])
    expect(unsafe.status).toBe(400)
    expect(await invalid.json()).toEqual({
      statusCode: 400,
      message: ['name: Expected a string', 'age: Expected a number'],
      error: 'Bad Request',
    })
  })

  it('rejects non-JSON bodies, invalid JSON and prototype pollution attempts', async () => {
    const request = await serve(AppModule)
    const text = await request('POST', '/users', { body: 'name=Ann', headers: { 'content-type': 'text/plain' } })
    const broken = await request('POST', '/users', { body: '{"name":', headers: { 'content-type': 'application/json' } })
    const proto = await request('POST', '/users', {
      body: '{"name":"Ann","age":1,"__proto__":{"admin":true}}',
      headers: { 'content-type': 'application/json' },
    })
    const escaped = await request('POST', '/users', {
      body: '{"name":"Ann","age":1,"\\u005f_proto__":{"admin":true}}',
      headers: { 'content-type': 'application/json' },
    })
    const constructorField = await request('POST', '/users', json({ name: 'Ann', age: 1, constructor: 'Ford' }))

    expect(text.status).toBe(415)
    expect(((await broken.json()) as { message: string }).message).toBe('Request body is not valid JSON')
    expect(((await proto.json()) as { message: string }).message).toBe('Request body contains a forbidden prototype property')
    expect(escaped.status).toBe(400)
    expect(constructorField.status).toBe(201)
  })

  it('refuses at startup a param() that is not in the route path', async () => {
    @Controller('/x')
    class Broken {
      @Get([param('id' as never)])
      read(): void {}
    }

    @Module({ controllers: [Broken] })
    class BrokenModule {}

    const container = await createContainer(BrokenModule)

    expect(() => controllerRoutes(container)).toThrow(
      new ControllerError('UNKNOWN_PARAM', `Broken.read: param('id') is not a parameter of "/x"`)
    )
  })
})

describe('responses', () => {
  @Controller('/r')
  class ResponsesController {
    @Get('/text')
    text(): string {
      return 'plain'
    }

    @Get('/json')
    json(): object {
      return { ok: true }
    }

    @Get('/empty')
    empty(): void {}

    @Get('/bytes')
    bytes(): Uint8Array {
      return new TextEncoder().encode('raw')
    }

    @Get('/raw')
    raw(): Response {
      return new Response('as is', { status: 418 })
    }

    @Get('/async')
    async later(): Promise<object> {
      await Bun.sleep(1)

      return { later: true }
    }

    @Post()
    create(): object {
      return { created: true }
    }

    @Delete(':id')
    @HttpCode(204)
    remove(): object {
      return { ignored: true }
    }

    @Get('/headers')
    @Header('cache-control', 'no-store')
    @Header('content-type', 'text/csv')
    csv(): string {
      return 'a,b'
    }
  }

  @Module({ controllers: [ResponsesController] })
  class AppModule {}

  it('serializes returned values like Nest', async () => {
    const request = await serve(AppModule)
    const text = await request('GET', '/r/text')
    const json = await request('GET', '/r/json')
    const empty = await request('GET', '/r/empty')
    const raw = await request('GET', '/r/raw')

    expect([text.headers.get('content-type'), await text.text()]).toEqual(['text/plain;charset=utf-8', 'plain'])
    expect([json.headers.get('content-type'), await json.json()]).toEqual(['application/json;charset=utf-8', { ok: true }])
    expect([empty.status, await empty.text()]).toEqual([200, ''])
    expect(await (await request('GET', '/r/bytes')).text()).toBe('raw')
    expect(await (await request('GET', '/r/async')).json()).toEqual({ later: true })
    expect([raw.status, await raw.text()]).toEqual([418, 'as is'])
  })

  it('answers 201 for POST, honours @HttpCode() and drops the body of a 204', async () => {
    const request = await serve(AppModule)
    const removed = await request('DELETE', '/r/1')

    expect((await request('POST', '/r')).status).toBe(201)
    expect([removed.status, await removed.text()]).toEqual([204, ''])
  })

  it('adds @Header() headers, a content type replacing the default one', async () => {
    const request = await serve(AppModule)
    const res = await request('GET', '/r/headers')

    expect([res.headers.get('cache-control'), res.headers.get('content-type'), await res.text()]).toEqual([
      'no-store',
      'text/csv',
      'a,b',
    ])
  })
})

describe('exceptions', () => {
  it('turns HttpExceptions into their response and hides other errors behind a 500', async () => {
    const logged: unknown[] = []

    @Controller('/e')
    class ErrorsController {
      @Get(':id')
      find(ctx: Context<':id'>): never {
        throw new NotFoundException(`User ${ctx.param('id')} not found`)
      }

      @Get('/auth')
      async auth(): Promise<never> {
        await Bun.sleep(1)

        throw new HttpException('Login required', 401, { headers: { 'www-authenticate': 'Bearer' } })
      }

      @Get('/crash')
      crash(): never {
        throw new Error('database password leaked in message')
      }
    }

    @Module({ controllers: [ErrorsController] })
    class AppModule {}

    const request = await serve(AppModule, { onError: (error) => logged.push(error) })
    const missing = await request('GET', '/e/7')
    const auth = await request('GET', '/e/auth')
    const crash = await request('GET', '/e/crash')

    expect([missing.status, await missing.json()]).toEqual([
      404,
      { statusCode: 404, message: 'User 7 not found', error: 'Not Found' },
    ])
    expect([auth.status, auth.headers.get('www-authenticate')]).toEqual([401, 'Bearer'])
    expect([crash.status, await crash.json()]).toEqual([500, { statusCode: 500, message: 'Internal server error' }])
    expect(logged).toHaveLength(1)
  })
})

describe('declaration errors', () => {
  it('refuses a module controller without @Controller()', async () => {
    class Plain {}

    @Module({ controllers: [Plain] })
    class AppModule {}

    const container = await createContainer(AppModule)

    expect(() => controllerRoutes(container)).toThrow(
      new ControllerError('NOT_A_CONTROLLER', 'Plain is listed in the controllers of AppModule but has no @Controller()')
    )
  })

  it('refuses route decorators on static and private methods', () => {
    expect(() => {
      @Controller()
      class StaticRoute {
        @Get()
        static list(): string {
          return ''
        }
      }

      return StaticRoute
    }).toThrow(/@Get\(\) must decorate a public instance method/)

    expect(() => {
      @Controller()
      class PrivateRoute {
        @Get()
        #list(): string {
          return ''
        }

        use(): string {
          return this.#list()
        }
      }

      return PrivateRoute
    }).toThrow(/@Get\(\) must decorate a public instance method/)
  })

  it('refuses invalid statuses and headers', () => {
    expect(() => {
      class InvalidStatus {
        @HttpCode(99)
        handle(): void {}
      }

      return InvalidStatus
    }).toThrow(/a response status is an integer from 200 to 599/)

    expect(() => {
      class InvalidHeader {
        @Header('bad header', 'x')
        handle(): void {}
      }

      return InvalidHeader
    }).toThrow(ControllerError)
  })

  // Checked by the type checker only, never called.
  const typeErrors = (): void => {
    class Typed {
      // @ts-expect-error the path has no `slug` parameter
      @Get(':id')
      contextMismatch(ctx: Context<':slug'>): void {
        void ctx
      }

      // @ts-expect-error `idd` is not a parameter of the path
      @Get(':id', [param('idd')])
      unknownParam(): void {}

      // @ts-expect-error int() gives a number, not a string
      @Get(':id', [param('id', int())])
      wrongType(id: string): void {
        void id
      }

      @Get(':id')
      typoInContext(ctx: Context<':id'>): void {
        // @ts-expect-error `idd` is not a parameter of the path
        ctx.param('idd')
      }
    }

    void Typed
  }

  void typeErrors
})
