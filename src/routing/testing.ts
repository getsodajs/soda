/**
 * @module
 * Test helpers for the route compiler. Not part of the public API.
 *
 * Every behavioural test runs against a real `Bun.serve()`: what is verified is
 * the behaviour of Bun's native router plus the compiled dispatchers, not a model of it.
 */

import { compileRoutes } from './compiler.ts'
import type { CompiledRoutes, CompileOptions, Params, RouteDefinition } from './types.ts'

/** Header carrying `{ route, params }` of the route that answered, readable on HEAD too. */
export const ROUTE_HEADER = 'x-route'

export interface Answer {
  readonly status: number
  /** Name of the route that answered, `undefined` for 404 and 405. */
  readonly route: string | undefined
  readonly params: Params | undefined
  readonly allow: string | null
  readonly body: string
}

/** Definitions in a compact form: `[method, path, routeName]`. */
export type Table = readonly (readonly [method: string, path: string, name: string])[]

export const definitionsOf = (table: Table): RouteDefinition[] => {
  const definitions: RouteDefinition[] = []

  for (let i = 0, len = table.length; i < len; i++) {
    const [method, path, name] = table[i]!

    definitions.push({
      method,
      path,
      handler: (_req, params) =>
        new Response(name, {
          headers: { [ROUTE_HEADER]: encodeURIComponent(JSON.stringify({ route: name, params: { ...params } })) },
        }),
    })
  }

  return definitions
}

const parseRouteHeader = (header: string | null): Pick<Answer, 'route' | 'params'> => {
  if (header === null) {
    return { route: undefined, params: undefined }
  }

  const { route, params } = JSON.parse(decodeURIComponent(header)) as { route: string; params?: Params }

  return { route, params }
}

/**
 * A running server that can be re-pointed at another route table with `server.reload()`.
 */
export class TestServer {
  readonly #server = Bun.serve({ port: 0, routes: {}, fetch: () => new Response(null, { status: 404 }) })

  get origin(): string {
    return this.#server.url.origin
  }

  load(table: Table, options?: CompileOptions): CompiledRoutes {
    const compiled = compileRoutes(definitionsOf(table), options)

    this.#server.reload(compiled)

    return compiled
  }

  /** Loads raw native routes, bypassing the compiler. */
  loadNative(routes: Record<string, (req: Bun.BunRequest) => Response>): void {
    this.#server.reload({ routes, fetch: () => new Response(null, { status: 404 }) })
  }

  /** Sends a request through `fetch`, like a regular client (which normalises the path). */
  async request(method: string, path: string): Promise<Answer> {
    const res = await fetch(this.origin + path, { method })

    return {
      ...parseRouteHeader(res.headers.get(ROUTE_HEADER)),
      status: res.status,
      allow: res.headers.get('allow'),
      body: await res.text(),
    }
  }

  /**
   * Sends `<method> <target>` verbatim over TCP: leading `//`, dot segments and odd
   * escapes reach Bun unchanged, unlike with `fetch`.
   */
  raw(method: string, target: string): Promise<Answer> {
    return new Promise((resolve, reject) => {
      let data = ''

      Bun.connect({
        hostname: '127.0.0.1',
        port: this.#server.port!,
        socket: {
          open: (socket) => {
            socket.write(`${method} ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`)
          },
          data: (_socket, chunk) => {
            data += chunk.toString()
          },
          close: () => {
            const end = data.indexOf('\r\n\r\n')
            const headers = new Map<string, string>()
            const lines = data.slice(0, end).split('\r\n')

            for (let i = 1; i < lines.length; i++) {
              const line = lines[i]!
              const colon = line.indexOf(':')

              headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim())
            }

            resolve({
              ...parseRouteHeader(headers.get(ROUTE_HEADER) ?? null),
              status: Number(lines[0]!.slice(9, 12)),
              allow: headers.get('allow') ?? null,
              body: data.slice(end + 4),
            })
          },
          error: (_socket, error) => reject(error),
        },
      }).catch(reject)
    })
  }

  stop(): void {
    this.#server.stop(true)
  }
}

/** Deterministic PRNG (mulberry32), so a failing randomized test can be replayed from its seed. */
export const createRandom = (seed: number): (() => number) => {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state

    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)]!
