/**
 * Randomized differential tests.
 *
 * 1. Precedence: for random tables of plain routes, the compiled router must
 *    pick the same route as Bun's own router given the same routes.
 * 2. Semantics: for random tables using every feature, the compiled router
 *    must give the same answer as a brute-force reference that checks every
 *    route against the path, written independently of the compiler.
 *
 * Seeds are fixed so a failure can be replayed; the failing seed is part of the assertion.
 */

import { afterAll, describe, expect, it } from 'bun:test'
import { compileRoutes } from './compiler'
import { decodeComponent } from './decode'
import { RouteError } from './errors'
import { expandOptional, parsePath } from './path'
import type { Segment } from './path'
import { TestServer, createRandom, definitionsOf, pick, ROUTE_HEADER } from './testing'
import type { Table } from './testing'
import type { Params } from './types'

const server = new TestServer()

afterAll(() => server.stop())

const REQUEST_SEGMENTS = ['a', 'b', '1', '22', 'c', '%61', '%2F', '']
const REQUEST_METHODS = ['GET', 'POST', 'PUT', 'HEAD', 'DELETE', 'REPORT']

const randomRequestPath = (random: () => number): string => {
  let path = ''

  for (let i = Math.floor(random() * 5); i > 0; i--) {
    path += `/${pick(random, REQUEST_SEGMENTS)}`
  }

  return path === '' ? '/' : path
}

/** Adds definitions one by one, dropping those that conflict with the ones already kept. */
const keepCompatible = (candidates: Table): Table => {
  const kept: (readonly [string, string, string])[] = []

  for (const definition of candidates) {
    try {
      compileRoutes(definitionsOf([...kept, definition]))
      kept.push(definition)
    } catch (error) {
      if (!(error instanceof RouteError) || error.code !== 'CONFLICT') {
        throw error
      }
    }
  }

  return kept
}

describe('precedence matches Bun', () => {
  const STATICS = ['a', 'b', '1']

  /** Random plain route path: statics, unnamed parameters, maybe a trailing wildcard. */
  const randomShape = (random: () => number): string => {
    let path = ''
    let slot = 0

    for (let i = Math.floor(random() * 4); i > 0; i--) {
      path += random() < 0.5 ? `/${pick(random, STATICS)}` : `/:p${slot++}`
    }

    if (random() < 0.3) {
      path += '/*'
    }

    return path === '' ? '/' : path
  }

  it('picks the same route as Bun.serve for 300 random tables', async () => {
    const seed = 7
    const random = createRandom(seed)

    for (let t = 0; t < 300; t++) {
      const paths = new Set<string>()

      for (let i = 1 + Math.floor(random() * 8); i > 0; i--) {
        paths.add(randomShape(random))
      }

      const table = keepCompatible([...paths].map((path) => ['GET', path, path] as const))

      // Bun has no wildcard bases: register '/a' for '/a/*' unless '/a' exists.
      const native: Record<string, (req: Bun.BunRequest) => Response> = {}
      const answer = (name: string) => () =>
        new Response(null, { headers: { [ROUTE_HEADER]: encodeURIComponent(JSON.stringify({ route: name })) } })

      for (const [, path] of table) {
        native[path] = answer(path)
      }

      for (const [, path] of table) {
        if (path.endsWith('/*')) {
          const base = path === '/*' ? '/' : path.slice(0, -2)

          native[base] ??= answer(path)
        }
      }

      const requests: string[] = []

      for (let i = 0; i < 25; i++) {
        requests.push(randomRequestPath(random))
      }

      server.loadNative(native)
      const expected: (string | undefined)[] = []

      for (const path of requests) {
        expected.push((await server.raw('GET', path)).route)
      }

      server.load(table)

      for (let i = 0; i < requests.length; i++) {
        const actual = (await server.raw('GET', requests[i]!)).route

        expect({ seed, table: t, path: requests[i], route: actual }).toEqual({
          seed,
          table: t,
          path: requests[i],
          route: expected[i],
        })
      }
    }
  })
})

describe('semantics match a brute-force reference', () => {
  interface ReferenceRoute {
    readonly method: string
    readonly name: string
    readonly segments: readonly Segment[]
    /** Wildcard base: '/files/*path' also matches '/files' with `path: ''`. */
    readonly base: { readonly wildcard: string | undefined } | undefined
    readonly order: number
  }

  const rank = (segment: Segment | undefined): number =>
    segment === undefined ? -1 : segment.type === 'static' ? 0 : segment.type === 'param' ? 1 : 2

  /** The documented precedence, restated from the specification. */
  const precedes = (a: ReferenceRoute, b: ReferenceRoute): number => {
    const len = Math.max(a.segments.length, b.segments.length)

    for (let i = 0; i < len; i++) {
      const diff = rank(a.segments[i]) - rank(b.segments[i])

      if (diff !== 0) {
        return diff
      }
    }

    for (let i = 0; i < a.segments.length; i++) {
      const sa = a.segments[i]!
      const sb = b.segments[i]!

      if (sa.type === 'param' && sb.type === 'param' && (sa.pattern === undefined) !== (sb.pattern === undefined)) {
        return sa.pattern === undefined ? 1 : -1
      }
    }

    if ((a.base === undefined) !== (b.base === undefined)) {
      return a.base === undefined ? -1 : 1
    }

    if ((a.method === 'ALL') !== (b.method === 'ALL')) {
      return a.method === 'ALL' ? 1 : -1
    }

    return a.order - b.order
  }

  const referenceRoutes = (table: Table): ReferenceRoute[] => {
    const routes: ReferenceRoute[] = []
    const explicit = new Set<string>()
    const identity = (method: string, segments: readonly Segment[]) =>
      method + segments.map((s) => (s.type === 'static' ? `/${s.value}` : s.type === 'param' ? `/:${s.pattern}` : '/*')).join('')

    for (const [order, [method, path, name]] of table.entries()) {
      for (const segments of expandOptional(path, parsePath(path))) {
        routes.push({ method: method.toUpperCase(), name, segments, base: undefined, order })
        explicit.add(identity(method.toUpperCase(), segments))
      }
    }

    // Wildcard bases are appended while iterating: the length is fixed to the explicit routes.
    for (let i = 0, len = routes.length; i < len; i++) {
      const route = routes[i]!
      const last = route.segments[route.segments.length - 1]

      if (last?.type === 'wildcard') {
        const segments = route.segments.slice(0, -1)

        if (!explicit.has(identity(route.method, segments))) {
          explicit.add(identity(route.method, segments))
          routes.push({ ...route, segments, base: { wildcard: last.name } })
        }
      }
    }

    return routes.sort(precedes)
  }

  const matchReference = (route: ReferenceRoute, parts: readonly string[]): Params | undefined => {
    const params: Params = {}
    const segments = route.segments
    const last = segments[segments.length - 1]
    const fixed = last?.type === 'wildcard' ? segments.length - 1 : segments.length

    if (last?.type === 'wildcard' ? parts.length < fixed + 1 : parts.length !== fixed) {
      return undefined
    }

    for (let i = 0; i < fixed; i++) {
      const segment = segments[i]!
      const part = parts[i]!

      if (segment.type === 'static') {
        if (part !== segment.value) {
          return undefined
        }
      } else if (segment.type === 'param') {
        const value = decodeComponent(part)

        if (part === '' || (segment.pattern !== undefined && !new RegExp(`^(?:${segment.pattern})$`).test(value))) {
          return undefined
        }

        params[segment.name] = value
      }
    }

    if (last?.type === 'wildcard' && last.name !== undefined) {
      params[last.name] = parts.slice(fixed).map(decodeComponent).join('/')
    }

    if (route.base?.wildcard !== undefined) {
      params[route.base.wildcard] = ''
    }

    return params
  }

  const reference = (routes: readonly ReferenceRoute[], method: string, path: string) => {
    const parts = path === '/' ? [] : path.slice(1).split('/')

    const find = (wanted: string) => {
      for (const route of routes) {
        if (route.method === wanted || route.method === 'ALL') {
          const params = matchReference(route, parts)

          if (params !== undefined) {
            return { status: 200, route: route.name, params, allow: null }
          }
        }
      }

      return undefined
    }

    const found = find(method) ?? (method === 'HEAD' ? find('GET') : undefined)

    if (found !== undefined) {
      return found
    }

    const allowed = new Set<string>()

    for (const route of routes) {
      if (matchReference(route, parts) !== undefined) {
        allowed.add(route.method)
      }
    }

    if (allowed.size === 0) {
      return { status: 404, route: undefined, params: undefined, allow: null }
    }

    if (allowed.has('GET')) {
      allowed.add('HEAD')
    }

    return { status: 405, route: undefined, params: undefined, allow: [...allowed].sort().join(', ') }
  }

  const STATICS = ['a', 'b', '1']
  const PATTERNS = [undefined, undefined, '\\d+', '[ab]', 'a|1', '.*']
  const METHODS = ['GET', 'GET', 'POST', 'ALL', 'DELETE']

  const randomPath = (random: () => number): string => {
    let path = ''
    let slot = 0
    const length = Math.floor(random() * 4)

    for (let i = 0; i < length; i++) {
      if (random() < 0.45) {
        path += `/${pick(random, STATICS)}`
      } else {
        const pattern = pick(random, PATTERNS)

        path += `/:p${slot++}${pattern === undefined ? '' : `{${pattern}}`}`
      }
    }

    const tail = random()

    if (tail < 0.15) {
      path += `/:p${slot}?`
    } else if (tail < 0.3) {
      path += random() < 0.5 ? '/*' : `/*p${slot}`
    }

    return path === '' ? '/' : path
  }

  it('gives the same answer as the reference for 300 random tables', async () => {
    const seed = 42
    const random = createRandom(seed)

    for (let t = 0; t < 300; t++) {
      const candidates: [string, string, string][] = []

      for (let i = 1 + Math.floor(random() * 8); i > 0; i--) {
        candidates.push([pick(random, METHODS), randomPath(random), `r${i}`])
      }

      const table = keepCompatible(candidates)
      const routes = referenceRoutes(table)

      server.load(table)

      for (let i = 0; i < 25; i++) {
        const method = pick(random, REQUEST_METHODS)
        const path = randomRequestPath(random)
        const { status, route, params, allow } = await server.raw(method, path)

        expect({ seed, table: t, method, path, answer: { status, route, params, allow } }).toEqual({
          seed,
          table: t,
          method,
          path,
          answer: reference(routes, method, path),
        })
      }
    }
  })
})
