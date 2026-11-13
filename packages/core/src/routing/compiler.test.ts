import { afterAll, describe, expect, it } from 'bun:test'
import { compileRoutes } from './compiler.ts'
import { RouteError } from './errors.ts'
import type { RouteErrorCode } from './errors.ts'
import { TestServer, definitionsOf } from './testing.ts'
import type { Table } from './testing.ts'

const server = new TestServer()

afterAll(() => server.stop())

/** Loads `table` and returns `[status, route, params]` of a request. */
const using = (table: Table) => {
  server.load(table)

  return async (method: string, path: string) => {
    const answer = await server.request(method, path)

    return [answer.status, answer.route, answer.params] as const
  }
}

const expectError = (table: Table, code: RouteErrorCode, message: RegExp): void => {
  let error: unknown

  try {
    compileRoutes(definitionsOf(table))
  } catch (caught) {
    error = caught
  }

  expect(error).toBeInstanceOf(RouteError)
  expect((error as RouteError).code).toBe(code)
  expect((error as RouteError).message).toMatch(message)
}

describe('static and parameter routes', () => {
  it('matches by path and method', async () => {
    const call = using([
      ['GET', '/', 'root'],
      ['GET', '/users', 'list'],
      ['post', '/users', 'create'],
      ['GET', '/users/:id', 'one'],
      ['PURGE', '/cache', 'purge'],
    ])

    expect(await call('GET', '/')).toEqual([200, 'root', {}])
    expect(await call('GET', '/users')).toEqual([200, 'list', {}])
    expect(await call('POST', '/users')).toEqual([200, 'create', {}])
    expect(await call('GET', '/users/42')).toEqual([200, 'one', { id: '42' }])
    expect(await call('PURGE', '/cache')).toEqual([200, 'purge', {}])
  })

  it('prefers a static segment over a parameter', async () => {
    const call = using([
      ['GET', '/users/:id', 'one'],
      ['GET', '/users/me', 'me'],
    ])

    expect(await call('GET', '/users/me')).toEqual([200, 'me', {}])
    expect(await call('GET', '/users/you')).toEqual([200, 'one', { id: 'you' }])
  })

  it('decodes parameters', async () => {
    const call = using([['GET', '/users/:id', 'one']])

    expect(await call('GET', '/users/a%20b')).toEqual([200, 'one', { id: 'a b' }])
    expect(await call('GET', '/users/a%2Fb')).toEqual([200, 'one', { id: 'a/b' }])
  })

  it('is strict about trailing slashes and never matches an empty parameter', async () => {
    const call = using([
      ['GET', '/users/:id', 'one'],
      ['GET', '/list/', 'list'],
    ])

    expect(await call('GET', '/users/')).toEqual([404, undefined, undefined])
    expect(await call('GET', '/users/42/')).toEqual([404, undefined, undefined])
    expect(await call('GET', '/list/')).toEqual([200, 'list', {}])
    expect(await call('GET', '/list')).toEqual([404, undefined, undefined])
  })

  it('matches static segments in the form clients send them', async () => {
    const call = using([
      ['GET', '/café', 'cafe'],
      ['GET', '/a b', 'space'],
    ])

    expect(await call('GET', '/café')).toEqual([200, 'cafe', {}])
    expect(await call('GET', '/caf%C3%A9')).toEqual([200, 'cafe', {}])
    expect(await call('GET', '/a%20b')).toEqual([200, 'space', {}])
  })
})

describe('methods', () => {
  it('answers 405 with Allow when only the method does not match', async () => {
    server.load([
      ['GET', '/items/:id', 'get'],
      ['DELETE', '/items/:id', 'delete'],
    ])
    const answer = await server.request('PUT', '/items/1')

    expect(answer.status).toBe(405)
    expect(answer.allow).toBe('DELETE, GET, HEAD')
  })

  it('falls back to a less specific route that has the method', async () => {
    const call = using([
      ['GET', '/me', 'me'],
      ['DELETE', '/:any', 'delete any'],
    ])

    expect(await call('DELETE', '/me')).toEqual([200, 'delete any', { any: 'me' }])
    expect(await call('GET', '/me')).toEqual([200, 'me', {}])
  })

  it('serves HEAD from GET without a body, and prefers an explicit HEAD route', async () => {
    server.load([
      ['GET', '/a', 'get a'],
      ['GET', '/b', 'get b'],
      ['HEAD', '/b', 'head b'],
    ])
    const a = await server.request('HEAD', '/a')

    expect([a.status, a.route, a.body]).toEqual([200, 'get a', ''])
    const b = await server.request('HEAD', '/b')

    expect([b.status, b.route, b.body]).toEqual([200, 'head b', ''])
  })

  it('lets a concrete method win over ALL regardless of declaration order', async () => {
    const call = using([
      ['ALL', '/hook', 'any'],
      ['POST', '/hook', 'post'],
    ])

    expect(await call('POST', '/hook')).toEqual([200, 'post', {}])
    expect(await call('PATCH', '/hook')).toEqual([200, 'any', {}])
    expect(await call('REPORT', '/hook')).toEqual([200, 'any', {}])
  })
})

describe('optional parameters', () => {
  it('matches with and without the optional segments', async () => {
    const call = using([
      ['GET', '/api/animals/:type?', 'animals'],
      ['GET', '/v1/:version?/:platform?', 'v1'],
    ])

    expect(await call('GET', '/api/animals')).toEqual([200, 'animals', {}])
    expect(await call('GET', '/api/animals/dog')).toEqual([200, 'animals', { type: 'dog' }])
    expect(await call('GET', '/v1')).toEqual([200, 'v1', {}])
    expect(await call('GET', '/v1/2')).toEqual([200, 'v1', { version: '2' }])
    expect(await call('GET', '/v1/2/ios')).toEqual([200, 'v1', { version: '2', platform: 'ios' }])
  })
})

describe('regex parameters', () => {
  it('tries constrained parameters before unconstrained ones, regardless of declaration order', async () => {
    const call = using([
      ['GET', '/posts/:slug', 'slug'],
      ['GET', '/posts/:id{\\d+}', 'id'],
    ])

    expect(await call('GET', '/posts/123')).toEqual([200, 'id', { id: '123' }])
    expect(await call('GET', '/posts/hello')).toEqual([200, 'slug', { slug: 'hello' }])
  })

  it('tests the decoded value', async () => {
    const call = using([['GET', '/tags/:tag{[a-z ]+}', 'tag']])

    expect(await call('GET', '/tags/a%20b')).toEqual([200, 'tag', { tag: 'a b' }])
  })

  it('falls back to a wildcard when the regex fails', async () => {
    const call = using([
      ['GET', '/files/*', 'files'],
      ['GET', '/files/:name{[a-z]+\\.txt}', 'txt'],
    ])

    expect(await call('GET', '/files/a.txt')).toEqual([200, 'txt', { name: 'a.txt' }])
    expect(await call('GET', '/files/A.PNG')).toEqual([200, 'files', {}])
  })

  it('answers 404, not 405, when the regex of every route fails', async () => {
    const call = using([
      ['GET', '/n/:id{\\d+}', 'get'],
      ['POST', '/n/:id{\\d+}', 'post'],
    ])

    expect(await call('PUT', '/n/abc')).toEqual([404, undefined, undefined])
    expect((await server.request('PUT', '/n/1')).allow).toBe('GET, HEAD, POST')
  })
})

describe('overlapping routes', () => {
  it('serves the intersection of two parameter routes natively', async () => {
    server.load([
      ['GET', '/a/:id', 'a'],
      ['POST', '/:tenant/b', 'b'],
    ])
    expect((await server.request('GET', '/a/b')).params).toEqual({ id: 'b' })
    const post = await server.request('POST', '/a/b')

    expect([post.route, post.params]).toEqual(['b', { tenant: 'a' }])
    expect((await server.request('PUT', '/a/b')).allow).toBe('GET, HEAD, POST')
    expect((await server.request('PUT', '/a/x')).allow).toBe('GET, HEAD')
  })

  it('checks a regex of a less specific route against the static segment at startup', async () => {
    const call = using([
      ['GET', '/users/me', 'me'],
      ['DELETE', '/users/:id{\\d+}', 'delete'],
    ])

    expect(await call('DELETE', '/users/1')).toEqual([200, 'delete', { id: '1' }])
    expect((await server.request('DELETE', '/users/me')).allow).toBe('GET, HEAD')
  })
})

describe('wildcards', () => {
  it('matches the base path and everything below it', async () => {
    const call = using([['GET', '/static/*', 'static']])

    expect(await call('GET', '/static')).toEqual([200, 'static', {}])
    expect(await call('GET', '/static/')).toEqual([200, 'static', {}])
    expect(await call('GET', '/static/a/b/c')).toEqual([200, 'static', {}])
    expect(await call('GET', '/statics')).toEqual([404, undefined, undefined])
  })

  it('loses to more specific routes, including an explicit route on its base path', async () => {
    const call = using([
      ['GET', '/x/*', 'wild'],
      ['GET', '/x', 'base'],
      ['GET', '/x/:id/y', 'param'],
    ])

    expect(await call('GET', '/x')).toEqual([200, 'base', {}])
    expect(await call('GET', '/x/1/y')).toEqual([200, 'param', { id: '1' }])
    expect(await call('GET', '/x/1/z')).toEqual([200, 'wild', {}])
  })

  it('gives a named wildcard the decoded remainder', async () => {
    const call = using([['GET', '/files/*path', 'files']])

    expect(await call('GET', '/files')).toEqual([200, 'files', { path: '' }])
    expect(await call('GET', '/files/')).toEqual([200, 'files', { path: '' }])
    expect(await call('GET', '/files/a/b%20c')).toEqual([200, 'files', { path: 'a/b c' }])
    expect(await call('GET', '/files/a%zz/b')).toEqual([200, 'files', { path: 'a\uFFFD/b' }])
  })

  it('computes a named wildcard inside a more specific native route', async () => {
    const call = using([
      ['GET', '/x/:id/y', 'param'],
      ['POST', '/x/*rest', 'rest'],
      ['GET', '/:any/*rest', 'any'],
    ])

    expect(await call('POST', '/x/1/y')).toEqual([200, 'rest', { rest: '1/y' }])
    expect(await call('GET', '/q/1/y')).toEqual([200, 'any', { any: 'q', rest: '1/y' }])
    expect(await call('GET', '/x/2/y')).toEqual([200, 'param', { id: '2' }])
  })

  it('does not match a named wildcard when the target has dot segments', async () => {
    server.load([['GET', '/files/*path', 'files']])
    expect((await server.raw('GET', '/files/a/b')).params).toEqual({ path: 'a/b' })
    expect((await server.raw('GET', '/files/../etc/passwd')).status).toBe(404)
  })
})

describe('options and reload', () => {
  it('uses a custom notFound for paths without any route', async () => {
    server.load([['GET', '/a', 'a']], { notFound: () => new Response('nope', { status: 418 }) })
    expect((await server.request('GET', '/b')).status).toBe(418)
  })

  it('swaps the whole table with server.reload()', async () => {
    expect(await using([['GET', '/v', 'old']])('GET', '/v')).toEqual([200, 'old', {}])
    expect(await using([['GET', '/v', 'new']])('GET', '/v')).toEqual([200, 'new', {}])
  })
})

describe('startup errors', () => {
  it('rejects the same route twice, whatever the parameter names', () => {
    expectError(
      [
        ['GET', '/users/:id', 'a'],
        ['GET', '/users/:userId', 'b'],
      ],
      'CONFLICT',
      /GET "\/users\/:userId" conflicts with GET "\/users\/:id"/
    )
    expectError(
      [
        ['GET', '/files/*', 'a'],
        ['GET', '/files/*path', 'b'],
      ],
      'CONFLICT',
      /conflicts/
    )
  })

  it('rejects a route that duplicates an optional expansion', () => {
    expectError(
      [
        ['GET', '/posts/:id?', 'a'],
        ['GET', '/posts', 'b'],
      ],
      'CONFLICT',
      /GET "\/posts" conflicts with GET "\/posts\/:id\?"/
    )
  })

  it('accepts the same path with another method, regex, or as a wildcard base', () => {
    expect(() =>
      compileRoutes(
        definitionsOf([
          ['GET', '/a/:id', 'a'],
          ['POST', '/a/:id', 'b'],
          ['ALL', '/a/:id', 'c'],
          ['GET', '/a/:id{\\d+}', 'd'],
          ['GET', '/b/*', 'e'],
          ['GET', '/b', 'f'],
        ])
      )
    ).not.toThrow()
  })

  it('rejects invalid methods and syntax', () => {
    expectError([['GE T', '/', 'a']], 'INVALID_METHOD', /Invalid HTTP method "GE T"/)
    expectError([['GET', '/a//b', 'a']], 'SYNTAX', /empty segment/)
  })

  it('rejects a table that expands into too many native routes', () => {
    // 40 routes, every '/sI/:x' intersects every '/:y/tJ': 40 + 20 * 20 native routes.
    const table: [string, string, string][] = []

    for (let i = 0; i < 20; i++) {
      table.push(['GET', `/s${i}/:x`, `s${i}`], ['POST', `/:y/t${i}`, `t${i}`])
    }

    expect(() => compileRoutes(definitionsOf(table), { maxNativeRoutes: 440 })).not.toThrow()
    let error: unknown

    try {
      compileRoutes(definitionsOf(table), { maxNativeRoutes: 439 })
    } catch (caught) {
      error = caught
    }

    expect((error as RouteError).code).toBe('TOO_COMPLEX')
  })
})
