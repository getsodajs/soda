/**
 * @module
 * Request-time part of the compiler: one dispatcher per native route.
 *
 * A dispatcher only knows the routes that can match its own native route,
 * resolved at startup, so the work per request never depends on the size of
 * the route table. Choosing between native routes, including backtracking,
 * is done by Bun itself.
 *
 * Hot path of a typical route: one method lookup, one branch, the handler call
 * with `req.params` as produced by Bun. No allocation, no URL parsing.
 */

import { createNullObject } from '../utils/object.ts'
import { decodeComponent } from './decode.ts'
import type { Handler, NativeHandler, Params } from './types.ts'

/**
 * How a candidate reads a value: from `req.params[key]`, or a constant known at
 * startup when the native route has a static segment where the route has a parameter.
 *
 * ```ts
 * // route '/:tenant/settings' served by native route '/acme/settings'
 * { key: undefined, constant: 'acme' }
 * ```
 */
export interface ValueSource {
  readonly key: string | undefined
  readonly constant: string
}

/**
 * Named wildcard of a candidate: its value is the decoded remainder of the path.
 */
export interface WildcardSpec {
  readonly name: string
  /** Segments of the native route covered by the wildcard. */
  readonly parts: readonly ValueSource[]
  /**
   * Set when the native route itself ends with a wildcard: the rest of the path
   * is read from `req.url`. `prefix` is the fixed part of the native route, used
   * to verify that `req.url` (normalised by Bun) still describes the raw path Bun
   * matched. Targets with dot segments fail that check and do not match.
   */
  readonly tail: { readonly prefix: readonly ValueSource[] } | undefined
}

/**
 * A route as seen from one native route.
 */
export interface Candidate {
  readonly method: string
  readonly handler: Handler
  /** Parallel arrays: `patterns[i]` is tested against `req.params[keys[i]]`. */
  readonly checkKeys: readonly string[]
  readonly checkPatterns: readonly RegExp[]
  /** Params passed as is, without reading the request. `undefined` with no builder: `req.params`. */
  readonly constantParams: Params | undefined
  /** Builds params per request; `undefined` result means the candidate does not match. */
  readonly buildParams: ((req: Bun.BunRequest) => Params | undefined) | undefined
}

interface Entry {
  /** Set when the first candidate always matches and takes `req.params` as is. */
  readonly direct: Handler | undefined
  readonly resolve: NativeHandler
}

const METHOD_ALL = 'ALL'
const METHOD_GET = 'GET'
const METHOD_HEAD = 'HEAD'

/**
 * Reads the segments of `req.url` after `prefix.length` segments.
 *
 * ```ts
 * // native route '/files/*', request '/files/a/b%20c'
 * readTail(req, [{ constant: 'files' }]) => 'a/b c'
 * ```
 */
const readTail = (req: Bun.BunRequest, prefix: readonly ValueSource[]): string | undefined => {
  const url = req.url
  let position = url.indexOf('/', url.indexOf('//') + 2)
  let end = url.indexOf('?', position)

  if (end === -1) {
    end = url.length
  }

  for (let i = 0, len = prefix.length; i < len; i++) {
    const next = url.indexOf('/', position + 1)

    if (next === -1 || next >= end) {
      return undefined
    }

    const source = prefix[i]!
    const segment = url.slice(position + 1, next)

    if (
      source.key === undefined ? segment !== source.constant : decodeComponent(segment) !== req.params[source.key]
    ) {
      return undefined
    }

    position = next
  }

  const tail = url.slice(position + 1, end)

  if (tail.indexOf('%') === -1) {
    return tail
  }

  // Decode segment by segment: a malformed escape must not swallow a '/'.
  const segments = tail.split('/')

  for (let i = 0, len = segments.length; i < len; i++) {
    segments[i] = decodeComponent(segments[i]!)
  }

  return segments.join('/')
}

const readValue = (req: Bun.BunRequest, source: ValueSource): string =>
  source.key === undefined ? source.constant : req.params[source.key]!

/**
 * Creates the params builder of a candidate that cannot pass `req.params` as is.
 */
export const createParamsBuilder = (
  names: readonly string[],
  sources: readonly ValueSource[],
  wildcard: WildcardSpec | undefined
): ((req: Bun.BunRequest) => Params | undefined) => {
  const count = names.length
  const parts = wildcard === undefined ? [] : wildcard.parts
  const partCount = parts.length
  const tail = wildcard?.tail

  return (req) => {
    const params = createNullObject<Params>()

    for (let i = 0; i < count; i++) {
      params[names[i]!] = readValue(req, sources[i]!)
    }

    if (wildcard !== undefined) {
      let value = ''

      for (let i = 0; i < partCount; i++) {
        value += i === 0 ? readValue(req, parts[i]!) : `/${readValue(req, parts[i]!)}`
      }

      if (tail !== undefined) {
        const rest = readTail(req, tail.prefix)

        if (rest === undefined) {
          return undefined
        }

        value += partCount === 0 ? rest : `/${rest}`
      }

      params[wildcard.name] = value
    }

    return params
  }
}

const passesChecks = (candidate: Candidate, req: Bun.BunRequest): boolean => {
  const keys = candidate.checkKeys
  const patterns = candidate.checkPatterns

  for (let i = 0, len = keys.length; i < len; i++) {
    if (!patterns[i]!.test(req.params[keys[i]!]!)) {
      return false
    }
  }

  return true
}

const alwaysMatches = (candidate: Candidate): boolean =>
  candidate.checkKeys.length === 0 && candidate.buildParams === undefined

const formatAllow = (methods: Set<string>): string => {
  if (methods.has(METHOD_GET)) {
    methods.add(METHOD_HEAD)
  }

  return [...methods].sort().join(', ')
}

const methodNotAllowed = (allow: string): Response =>
  new Response('Method Not Allowed', { status: 405, headers: { allow } })

/**
 * Creates the handler of one native route.
 *
 * `candidates` are the routes that can match this native route, in precedence order.
 */
export const createDispatcher = (
  candidates: readonly Candidate[],
  notFound: (req: Request) => Response | Promise<Response>
): NativeHandler => {
  const total = candidates.length

  if (total === 0) {
    return notFound
  }

  // 405 or 404 once no candidate of the request method matched.
  let everyAlwaysMatches = true
  const methods = new Set<string>()

  for (let i = 0; i < total; i++) {
    const candidate = candidates[i]!

    methods.add(candidate.method)

    if (!alwaysMatches(candidate)) {
      everyAlwaysMatches = false
    }
  }

  methods.delete(METHOD_ALL)

  let miss: NativeHandler

  if (everyAlwaysMatches) {
    const allow = formatAllow(new Set(methods))

    miss = allow === '' ? notFound : () => methodNotAllowed(allow)
  } else {
    miss = (req) => {
      const allowed = new Set<string>()

      for (let i = 0; i < total; i++) {
        const candidate = candidates[i]!

        if (
          passesChecks(candidate, req) &&
          (candidate.buildParams === undefined || candidate.buildParams(req) !== undefined)
        ) {
          allowed.add(candidate.method)
        }
      }

      return allowed.size === 0 ? notFound(req) : methodNotAllowed(formatAllow(allowed))
    }
  }

  const createEntry = (list: readonly Candidate[]): Entry => {
    const len = list.length
    const first = list[0]

    if (first !== undefined && alwaysMatches(first)) {
      const { handler, constantParams } = first

      return constantParams === undefined
        ? { direct: handler, resolve: miss }
        : { direct: undefined, resolve: (req) => handler(req, constantParams) }
    }

    if (len === 0) {
      return { direct: undefined, resolve: miss }
    }

    return {
      direct: undefined,
      resolve: (req) => {
        for (let i = 0; i < len; i++) {
          const candidate = list[i]!

          if (!passesChecks(candidate, req)) {
            continue
          }

          if (candidate.buildParams === undefined) {
            return candidate.handler(req, candidate.constantParams ?? req.params)
          }

          const params = candidate.buildParams(req)

          if (params !== undefined) {
            return candidate.handler(req, params)
          }
        }

        return miss(req)
      },
    }
  }

  const select = (method: string): Candidate[] => {
    const list: Candidate[] = []

    for (let i = 0; i < total; i++) {
      const candidate = candidates[i]!

      if (candidate.method === method || candidate.method === METHOD_ALL) {
        list.push(candidate)
      }
    }

    return list
  }

  const table = createNullObject<Record<string, Entry>>()

  for (const method of methods) {
    table[method] = createEntry(select(method))
  }

  // HEAD is served by HEAD and ALL routes first, then by GET routes.
  if (methods.has(METHOD_GET)) {
    const head = select(METHOD_HEAD)

    for (let i = 0; i < total; i++) {
      const candidate = candidates[i]!

      if (candidate.method === METHOD_GET) {
        head.push(candidate)
      }
    }

    table[METHOD_HEAD] = createEntry(head)
  }

  const other = createEntry(select(METHOD_ALL))

  return (req) => {
    const entry = table[req.method] ?? other

    return entry.direct !== undefined ? entry.direct(req, req.params) : entry.resolve(req)
  }
}
