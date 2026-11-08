/**
 * @module
 * Compiles a route table into Bun's native router.
 *
 * Every decision is taken once, at startup:
 *
 * 1. Paths are parsed, optional parameters expanded, wildcard bases added
 *    (`/files/*` also serves `/files`), conflicts reported.
 * 2. Routes are sorted by precedence: Bun's shape order first, then
 *    constrained before unconstrained parameters, explicit before wildcard
 *    bases, concrete methods before `ALL`, declaration order.
 * 3. The set of native routes is closed under intersection: if `/a/:id` and
 *    `/:tenant/b` both exist, `/a/b` is added. Bun therefore always lands on a
 *    native route whose candidates are exactly the routes that can match the
 *    request, and no request ever has to look at another native route.
 * 4. Each native route gets a dispatcher holding only its candidates.
 */

import { createNullObject } from '../utils/object'
import { decodeComponent } from './decode'
import { createDispatcher, createParamsBuilder } from './dispatch'
import type { Candidate, ValueSource, WildcardSpec } from './dispatch'
import { RouteError } from './errors'
import { expandOptional, parsePath } from './path'
import type { Segment } from './path'
import { compareShapes, containsShape, intersectShapes, shapeId, shapeKey, shapeOf } from './shape'
import type { Shape } from './shape'
import { MAX_NATIVE_ROUTES, METHOD_ALL } from './types'
import type { CompiledRoutes, CompileOptions, Handler, NativeHandler, Params, RouteDefinition } from './types'

interface Route {
  readonly method: string
  /** Path as written in the definition, for error messages. */
  readonly path: string
  readonly handler: Handler
  readonly name: string | undefined
  readonly segments: readonly Segment[]
  readonly shape: Shape
  /** Set on the base route of a wildcard: '/files/*path' also serves '/files' with `path: ''`. */
  readonly baseOf: { readonly wildcard: string | undefined } | undefined
  readonly order: number
}

const METHOD_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const EMPTY_PARAMS: Params = Object.freeze(createNullObject<Params>())

const defaultNotFound = (): Response => new Response('Not Found', { status: 404 })

const describeRoute = (route: Route): string =>
  `${route.method} "${route.path}"${route.name === undefined ? '' : ` (${route.name})`}${route.baseOf === undefined ? '' : ' (wildcard base)'}`

/**
 * What a route matches, ignoring names: two explicit routes with the same identity and
 * method can never both be reached.
 *
 * ```ts
 * '/users/:id' and '/users/:userId'     => '/users/:'
 * '/files/*' and '/files/*path'         => '/files/*'
 * ```
 */
const identityOf = (segments: readonly Segment[]): string => {
  let identity = ''

  for (let i = 0, len = segments.length; i < len; i++) {
    const segment = segments[i]!

    identity +=
      segment.type === 'static'
        ? `/${segment.value}`
        : segment.type === 'param'
          ? `/:${segment.pattern === undefined ? '' : `{${segment.pattern}}`}`
          : '/*'
  }

  return identity === '' ? '/' : identity
}

const compareRoutes = (a: Route, b: Route): number => {
  const byShape = compareShapes(a.shape, b.shape)

  if (byShape !== 0) {
    return byShape
  }

  // Equal ranks: parameters sit at the same positions, constrained ones go first.
  const len = a.segments.length < b.segments.length ? a.segments.length : b.segments.length

  for (let i = 0; i < len; i++) {
    const segmentA = a.segments[i]!
    const segmentB = b.segments[i]!

    if (segmentA.type === 'param' && segmentB.type === 'param') {
      const diff = Number(segmentA.pattern === undefined) - Number(segmentB.pattern === undefined)

      if (diff !== 0) {
        return diff
      }
    }
  }

  return (
    Number(a.baseOf !== undefined) - Number(b.baseOf !== undefined) ||
    Number(a.method === METHOD_ALL) - Number(b.method === METHOD_ALL) ||
    a.order - b.order
  )
}

/**
 * Parses every definition into routes and rejects conflicting ones.
 */
const collectRoutes = (definitions: readonly RouteDefinition[]): Route[] => {
  const explicit = new Map<string, Route>()
  const bases: Route[] = []

  for (let order = 0, len = definitions.length; order < len; order++) {
    const { method: rawMethod, path, handler, name } = definitions[order]!

    if (!METHOD_TOKEN.test(rawMethod)) {
      throw new RouteError('INVALID_METHOD', `Invalid HTTP method "${rawMethod}" for route "${path}"`)
    }

    const method = rawMethod.toUpperCase()
    const variants = expandOptional(path, parsePath(path))

    for (let v = 0, count = variants.length; v < count; v++) {
      const segments = variants[v]!
      const route: Route = { method, path, handler, name, segments, shape: shapeOf(segments), baseOf: undefined, order }

      const key = `${method} ${identityOf(segments)}`
      const previous = explicit.get(key)

      if (previous !== undefined) {
        throw new RouteError(
          'CONFLICT',
          `Route ${describeRoute(route)} conflicts with ${describeRoute(previous)}: both match the same requests`
        )
      }

      explicit.set(key, route)

      const last = segments[segments.length - 1]

      if (last !== undefined && last.type === 'wildcard') {
        const base = segments.slice(0, -1)

        bases.push({ ...route, segments: base, shape: shapeOf(base), baseOf: { wildcard: last.name } })
      }
    }
  }

  const routes = [...explicit.values()]
  const seenBases = new Set<string>()

  for (let i = 0, len = bases.length; i < len; i++) {
    const base = bases[i]!
    const key = `${base.method} ${identityOf(base.segments)}`

    // An explicit route on the base path wins over the wildcard base.
    if (!explicit.has(key) && !seenBases.has(key)) {
      seenBases.add(key)
      routes.push(base)
    }
  }

  return routes
}

/**
 * Closes the set of route shapes under intersection.
 *
 * Intersection is associative, so intersecting every shape, including new
 * ones, with the original shapes only is enough: O(native routes × routes).
 *
 * ```ts
 * '/users/me', '/users/:', '/:/settings' => + '/users/settings'
 * ```
 */
const closeShapes = (routes: readonly Route[], limit: number): Shape[] => {
  const shapes: Shape[] = []
  const ids = new Set<string>()

  const add = (shape: Shape): void => {
    const id = shapeId(shape)

    if (ids.has(id)) {
      return
    }

    if (shapes.length === limit) {
      throw new RouteError(
        'TOO_COMPLEX',
        `The route table expands into more than ${limit} native routes; reduce overlapping parameter routes`
      )
    }

    ids.add(id)
    shapes.push(shape)
  }

  for (let i = 0, len = routes.length; i < len; i++) {
    add(routes[i]!.shape)
  }

  const originals = shapes.length

  // `shapes` grows while iterating, new shapes are intersected too.
  for (let i = 0; i < shapes.length; i++) {
    for (let j = 0; j < originals; j++) {
      const intersection = intersectShapes(shapes[i]!, shapes[j]!)

      if (intersection !== undefined) {
        add(intersection)
      }
    }
  }

  return shapes
}

const regexCache = new Map<string, RegExp>()

const anchored = (pattern: string): RegExp => {
  let regex = regexCache.get(pattern)

  if (regex === undefined) {
    regex = new RegExp(`^(?:${pattern})$`)
    regexCache.set(pattern, regex)
  }

  return regex
}

/**
 * Names Bun will use for the parameter slots of `shape`: those of the first
 * candidate that maps onto the slots exactly, so that it can take `req.params`
 * as is. Otherwise positional names.
 */
const chooseKeyNames = (shape: Shape, routes: readonly Route[]): string[] => {
  const tokens = shape.tokens

  for (let r = 0, count = routes.length; r < count; r++) {
    const segments = routes[r]!.segments
    const names: string[] = []
    let exact = segments.length === tokens.length

    for (let i = 0, len = segments.length; exact && i < len; i++) {
      const segment = segments[i]!

      if (segment.type === 'param') {
        if (tokens[i] !== null) {
          exact = false
        } else {
          names.push(segment.name)
        }
      } else if (segment.type === 'wildcard') {
        exact = false
      }
    }

    if (exact) {
      return names
    }
  }

  const names: string[] = []

  for (let i = 0, len = tokens.length; i < len; i++) {
    if (tokens[i] === null) {
      names.push(`p${names.length}`)
    }
  }

  return names
}

/**
 * Describes `route` as a candidate of the native route `shape`,
 * or returns `undefined` if it can never match there.
 */
const createCandidate = (route: Route, shape: Shape, keyNames: readonly string[]): Candidate | undefined => {
  const tokens = shape.tokens
  const segments = route.segments
  const keys: (string | undefined)[] = []

  for (let i = 0, slot = 0, len = tokens.length; i < len; i++) {
    keys.push(tokens[i] === null ? keyNames[slot++] : undefined)
  }

  const sourceAt = (position: number): ValueSource => {
    const key = keys[position]

    return key === undefined ? { key, constant: decodeComponent(tokens[position]!) } : { key, constant: '' }
  }

  const checkKeys: string[] = []
  const checkPatterns: RegExp[] = []
  const names: string[] = []
  const sources: ValueSource[] = []
  let wildcard: WildcardSpec | undefined

  for (let i = 0, len = segments.length; i < len; i++) {
    const segment = segments[i]!

    if (segment.type === 'param') {
      const source = sourceAt(i)

      if (segment.pattern !== undefined) {
        const pattern = anchored(segment.pattern)

        if (source.key === undefined) {
          // Static segment of the native route: decided now.
          if (!pattern.test(source.constant)) {
            return undefined
          }
        } else {
          checkKeys.push(source.key)
          checkPatterns.push(pattern)
        }
      }

      names.push(segment.name)
      sources.push(source)
    } else if (segment.type === 'wildcard' && segment.name !== undefined) {
      const parts: ValueSource[] = []

      for (let p = i; p < tokens.length; p++) {
        parts.push(sourceAt(p))
      }

      let tail: WildcardSpec['tail']

      if (shape.tail) {
        const prefix: ValueSource[] = []

        for (let p = 0; p < tokens.length; p++) {
          const key = keys[p]

          prefix.push(key === undefined ? { key, constant: tokens[p]! } : { key, constant: '' })
        }

        tail = { prefix }
      }

      wildcard = { name: segment.name, parts, tail }
    }
  }

  const base = route.baseOf

  if (base !== undefined && base.wildcard !== undefined) {
    names.push(base.wildcard)
    sources.push({ key: undefined, constant: '' })
  }

  const { method, handler } = route
  const common = { method, handler, checkKeys, checkPatterns }

  if (wildcard !== undefined) {
    return { ...common, constantParams: undefined, buildParams: createParamsBuilder(names, sources, wildcard) }
  }

  let native = names.length === keyNames.length
  let constant = true

  for (let i = 0, len = names.length; i < len; i++) {
    const key = sources[i]!.key

    if (key === undefined) {
      native = false
    } else {
      constant = false

      if (key !== names[i]) {
        native = false
      }
    }
  }

  if (native) {
    return { ...common, constantParams: undefined, buildParams: undefined }
  }

  if (constant) {
    let params = EMPTY_PARAMS

    if (names.length > 0) {
      params = createNullObject<Params>()

      for (let i = 0, len = names.length; i < len; i++) {
        params[names[i]!] = sources[i]!.constant
      }

      Object.freeze(params)
    }

    return { ...common, constantParams: params, buildParams: undefined }
  }

  return { ...common, constantParams: undefined, buildParams: createParamsBuilder(names, sources, undefined) }
}

/**
 * Compiles route definitions into `routes` and `fetch` for `Bun.serve()`.
 *
 * Throws `RouteError` on invalid syntax, invalid methods and conflicting routes.
 *
 * ```ts
 * const server = Bun.serve({
 *   port: 3000,
 *   ...compileRoutes([
 *     { method: 'GET', path: '/users/:id{\\d+}', handler: (req, params) => getUser(params.id) },
 *   ]),
 * })
 * ```
 */
export const compileRoutes = (
  definitions: readonly RouteDefinition[],
  options: CompileOptions = {}
): CompiledRoutes => {
  const notFound = options.notFound ?? defaultNotFound
  const routes = collectRoutes(definitions).sort(compareRoutes)
  const shapes = closeShapes(routes, options.maxNativeRoutes ?? MAX_NATIVE_ROUTES)

  const native: Record<string, NativeHandler> = {}

  for (let s = 0, count = shapes.length; s < count; s++) {
    const shape = shapes[s]!
    const matching: Route[] = []

    for (let r = 0, len = routes.length; r < len; r++) {
      const route = routes[r]!

      if (containsShape(route.shape, shape)) {
        matching.push(route)
      }
    }

    const keyNames = chooseKeyNames(shape, matching)
    const candidates: Candidate[] = []

    for (let r = 0, len = matching.length; r < len; r++) {
      const candidate = createCandidate(matching[r]!, shape, keyNames)

      if (candidate !== undefined) {
        candidates.push(candidate)
      }
    }

    native[shapeKey(shape, keyNames)] = createDispatcher(candidates, notFound)
  }

  return { routes: native, fetch: notFound }
}
