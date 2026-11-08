/**
 * @module
 * Route path syntax: parsing, validation, normalisation and optional-parameter expansion.
 */

import { RouteError } from './errors'

/**
 * One segment of a parsed route path.
 *
 * Static values are stored in the exact form Bun compares them with the raw
 * request target: percent-encoded, with upper-case escapes.
 */
export type Segment =
  | { readonly type: 'static'; readonly value: string }
  | {
      readonly type: 'param'
      readonly name: string
      /** Regex source from `:name{...}`, tested against the decoded value. */
      readonly pattern: string | undefined
      readonly optional: boolean
    }
  | { readonly type: 'wildcard'; readonly name: string | undefined }

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
const LOWER_CASE_ESCAPE = /%[0-9a-f]{2}/gi
const FORBIDDEN_IN_STATIC = /[:*{}?#\\]/

const syntaxError = (path: string, reason: string): RouteError =>
  new RouteError('SYNTAX', `Invalid route path "${path}": ${reason}`)

/**
 * Splits a route path into raw segments.
 * Slashes inside `{...}` belong to the regex, backslash escapes are honoured there.
 *
 * ```ts
 * '/'                 => []
 * '/a/:b{[^/]+}/c'    => ['a', ':b{[^/]+}', 'c']
 * ```
 */
const splitSegments = (path: string): string[] => {
  const segments: string[] = []

  if (path === '/') {
    return segments
  }

  let start = 1
  let depth = 0

  for (let i = 1, len = path.length; i < len; i++) {
    const char = path[i]

    if (depth > 0 && char === '\\') {
      i++
    } else if (char === '{') {
      depth++
    } else if (char === '}') {
      if (--depth < 0) {
        throw syntaxError(path, 'unbalanced "}"')
      }
    } else if (char === '/' && depth === 0) {
      segments.push(path.slice(start, i))
      start = i + 1
    }
  }

  if (depth !== 0) {
    throw syntaxError(path, 'unbalanced "{"')
  }

  segments.push(path.slice(start))

  return segments
}

/**
 * Brings a static segment to the form a client sends it in:
 * WHATWG percent-encoding (`é` => `%C3%A9`, ` ` => `%20`) and upper-case escapes.
 */
const normalizeStatic = (path: string, segment: string): string => {
  if (FORBIDDEN_IN_STATIC.test(segment)) {
    throw syntaxError(
      path,
      `"${segment}": ":", "*", "{", "}", "?", "#" and "\\" are not allowed in a static segment`
    )
  }

  const normalized = new URL(`http://h/${segment}`).pathname
    .slice(1)
    .replace(LOWER_CASE_ESCAPE, (escape) => escape.toUpperCase())

  // '.', '..', '%2e' are dot segments: clients resolve them, they never reach the server
  if (normalized === '' && segment !== '') {
    throw syntaxError(path, `"${segment}" is a dot segment`)
  }

  return normalized
}

const parseParam = (path: string, raw: string): Segment => {
  let body = raw.slice(1)
  const optional = body.endsWith('?')

  if (optional) {
    body = body.slice(0, -1)
  }

  const brace = body.indexOf('{')
  const name = brace === -1 ? body : body.slice(0, brace)

  if (!IDENTIFIER.test(name)) {
    throw syntaxError(path, `"${name}" is not a valid parameter name`)
  }

  if (brace === -1) {
    return { type: 'param', name, pattern: undefined, optional }
  }

  if (!body.endsWith('}')) {
    throw syntaxError(path, `unexpected characters after the regex of ":${name}"`)
  }

  const pattern = body.slice(brace + 1, -1)

  if (pattern === '') {
    throw syntaxError(path, `empty regex for ":${name}"`)
  }

  try {
    new RegExp(pattern)
  } catch (error) {
    throw syntaxError(path, `invalid regex for ":${name}": ${(error as Error).message}`)
  }

  return { type: 'param', name, pattern, optional }
}

/**
 * Parses and validates a route path.
 *
 * ```ts
 * '/users/:id{\\d+}/*rest' => [
 *   { type: 'static', value: 'users' },
 *   { type: 'param', name: 'id', pattern: '\\d+', optional: false },
 *   { type: 'wildcard', name: 'rest' },
 * ]
 * ```
 */
export const parsePath = (path: string): Segment[] => {
  if (path[0] !== '/') {
    throw syntaxError(path, 'must start with "/"')
  }

  const raw = splitSegments(path)
  const segments: Segment[] = []
  const names = new Set<string>()
  const last = raw.length - 1

  for (let i = 0; i <= last; i++) {
    const part = raw[i]!
    let segment: Segment

    if (part[0] === '*') {
      const name = part === '*' ? undefined : part.slice(1)

      if (name !== undefined && !IDENTIFIER.test(name)) {
        throw syntaxError(path, `"${name}" is not a valid wildcard name`)
      }

      if (i !== last) {
        throw syntaxError(path, 'a wildcard must be the last segment')
      }

      segment = { type: 'wildcard', name }
    } else if (part[0] === ':') {
      segment = parseParam(path, part)
    } else {
      if (part === '' && i !== last) {
        throw syntaxError(path, 'empty segment')
      }

      segment = { type: 'static', value: normalizeStatic(path, part) }
    }

    if (segment.type !== 'static' && segment.name !== undefined) {
      if (names.has(segment.name)) {
        throw syntaxError(path, `duplicate parameter "${segment.name}"`)
      }

      names.add(segment.name)
    }

    segments.push(segment)
  }

  return segments
}

/**
 * Expands trailing optional parameters into plain paths.
 *
 * ```ts
 * '/v1/:version?/:platform?' => '/v1', '/v1/:version', '/v1/:version/:platform'
 * '/:a?/b'                   => RouteError: only trailing parameters can be optional
 * ```
 */
export const expandOptional = (path: string, segments: readonly Segment[]): Segment[][] => {
  const len = segments.length
  let first = len

  for (let i = 0; i < len; i++) {
    const segment = segments[i]!

    if (segment.type === 'param' && segment.optional) {
      first = i
      break
    }
  }

  if (first === len) {
    return [segments.slice()]
  }

  const required: Segment[] = []

  for (let i = 0; i < len; i++) {
    const segment = segments[i]!

    if (i >= first && !(segment.type === 'param' && segment.optional)) {
      throw syntaxError(path, 'only trailing parameters can be optional')
    }

    required.push(segment.type === 'param' ? { ...segment, optional: false } : segment)
  }

  const variants: Segment[][] = []

  for (let size = first; size <= len; size++) {
    variants.push(required.slice(0, size))
  }

  return variants
}
