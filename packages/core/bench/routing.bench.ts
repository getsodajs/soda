/**
 * Cost added by the compiled dispatchers on top of calling the handler directly.
 *
 * Bun's native matching happens before the dispatcher and is identical to plain
 * `Bun.serve({ routes })`, so the dispatcher is the only overhead of the compiler.
 * Handlers return a prebuilt Response to keep the measurement on routing.
 *
 * Run: bun bench/routing.bench.ts
 */

import { compileRoutes } from '../src/routing/index.ts'
import type { Handler, Params } from '../src/routing/index.ts'

const RESPONSE = new Response('ok')
let sink = 0

const handler: Handler = (_req, params: Params) => {
  sink += params === undefined ? 0 : 1

  return RESPONSE
}

const { routes } = compileRoutes([
  { method: 'GET', path: '/users/:id', handler },
  { method: 'POST', path: '/users/:id', handler },
  { method: 'GET', path: '/posts/:slug', handler },
  { method: 'GET', path: '/posts/:id{\\d+}', handler },
  { method: 'GET', path: '/files/*path', handler },
  { method: 'GET', path: '/me', handler },
  { method: 'DELETE', path: '/:any', handler },
])

const request = (method: string, url: string, params: Record<string, string>) =>
  ({ method, url: `http://localhost${url}`, params }) as unknown as Bun.BunRequest

const measure = (name: string, run: () => unknown): void => {
  const iterations = 5_000_000

  for (let i = 0; i < 200_000; i++) {
    run()
  }

  let best = Number.POSITIVE_INFINITY

  for (let round = 0; round < 5; round++) {
    const start = Bun.nanoseconds()

    for (let i = 0; i < iterations; i++) {
      run()
    }

    best = Math.min(best, (Bun.nanoseconds() - start) / iterations)
  }

  console.log(`${name.padEnd(48)} ${best.toFixed(2).padStart(7)} ns/op`)
}

const route = (key: string) => {
  const native = routes[key]

  if (native === undefined) {
    throw new Error(`no native route ${key}; have: ${Object.keys(routes).join(', ')}`)
  }

  return native
}

const userGet = request('GET', '/users/42', { id: '42' })
const userPut = request('PUT', '/users/42', { id: '42' })
const postId = request('GET', '/posts/123', { id: '123' })
const postSlug = request('GET', '/posts/hello', { id: 'hello' })
const file = request('GET', '/files/a/b/c.txt', {})
const meDelete = request('DELETE', '/me', {})

measure('baseline: handler(req, req.params)', () => handler(userGet, userGet.params))
measure('GET /users/:id (plain parameter)', () => route('/users/:id')(userGet))
measure('GET /posts/123 (regex matches)', () => route('/posts/:id')(postId))
measure('GET /posts/hello (regex fails, next candidate)', () => route('/posts/:id')(postSlug))
measure('DELETE /me (less specific route, constant param)', () => route('/me')(meDelete))
measure('GET /files/a/b/c.txt (named wildcard, reads url)', () => route('/files/*')(file))
measure('PUT /users/42 (405, builds a Response)', () => route('/users/:id')(userPut))

if (sink === -1) {
  console.log(sink)
}
