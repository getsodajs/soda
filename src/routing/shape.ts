/**
 * @module
 * Shapes: the part of a route that Bun's native router sees.
 *
 * A shape is a sequence of static values and parameter slots, optionally
 * followed by a wildcard tail. Regexes, names and methods are not part of it.
 *
 * ```ts
 * '/users/:id{\\d+}'  => { tokens: ['users', null], tail: false }   // key '/users/:'
 * '/files/*'         => { tokens: ['files'], tail: true }          // key '/files/*'
 * ```
 *
 * Bun picks, for a raw request path, the first matching shape in this order:
 * static before parameter before tail, compared segment by segment, with
 * backtracking. `compareShapes` reproduces that order.
 */

import type { Segment } from './path'

/** `null` is a parameter slot. */
export type Token = string | null

export interface Shape {
  readonly tokens: readonly Token[]
  /** `true` if the shape ends with a wildcard, which consumes one or more segments. */
  readonly tail: boolean
}

const RANK_STATIC = 0
const RANK_PARAM = 1
const RANK_TAIL = 2

export const shapeOf = (segments: readonly Segment[]): Shape => {
  const tokens: Token[] = []
  let tail = false

  for (let i = 0, len = segments.length; i < len; i++) {
    const segment = segments[i]!

    if (segment.type === 'static') {
      tokens.push(segment.value)
    } else if (segment.type === 'param') {
      tokens.push(null)
    } else {
      tail = true
    }
  }

  return { tokens, tail }
}

/**
 * Identity of a shape, also a valid Bun route key without parameter names.
 *
 * ```ts
 * { tokens: ['users', null], tail: true } => '/users/:/*'
 * ```
 */
export const shapeId = (shape: Shape): string => {
  let id = ''
  const { tokens } = shape

  for (let i = 0, len = tokens.length; i < len; i++) {
    const token = tokens[i]

    id += token === null ? '/:' : `/${token}`
  }

  if (shape.tail) {
    id += '/*'
  }

  return id === '' ? '/' : id
}

/**
 * Bun route key of a shape, with the given names for its parameter slots.
 *
 * ```ts
 * ({ tokens: ['users', null], tail: false }, ['id']) => '/users/:id'
 * ```
 */
export const shapeKey = (shape: Shape, names: readonly string[]): string => {
  let key = ''
  let slot = 0
  const { tokens } = shape

  for (let i = 0, len = tokens.length; i < len; i++) {
    const token = tokens[i]

    key += token === null ? `/:${names[slot++]}` : `/${token}`
  }

  if (shape.tail) {
    key += '/*'
  }

  return key === '' ? '/' : key
}

/**
 * Bun's precedence between two shapes: negative if `a` is tried first.
 *
 * Shapes with equal ranks never match the same path unless they are equal,
 * so `0` for different shapes only means "no path matches both".
 */
export const compareShapes = (a: Shape, b: Shape): number => {
  const lengthA = a.tokens.length
  const lengthB = b.tokens.length
  const len = lengthA < lengthB ? lengthA : lengthB

  for (let i = 0; i < len; i++) {
    const diff = (a.tokens[i] === null ? RANK_PARAM : RANK_STATIC) - (b.tokens[i] === null ? RANK_PARAM : RANK_STATIC)

    if (diff !== 0) {
      return diff
    }
  }

  // Common prefix is equal: the tail ranks after any token at the same position.
  const rankA = lengthA > len ? (a.tokens[len] === null ? RANK_PARAM : RANK_STATIC) : a.tail ? RANK_TAIL : -1
  const rankB = lengthB > len ? (b.tokens[len] === null ? RANK_PARAM : RANK_STATIC) : b.tail ? RANK_TAIL : -1

  return rankA - rankB
}

/**
 * Most general shape matching exactly the paths matched by both `a` and `b`,
 * or `undefined` if no path matches both.
 *
 * ```ts
 * '/a/:'   ∩ '/:/b'   => '/a/b'
 * '/x/*'   ∩ '/x/:/y' => '/x/:/y'
 * '/a/*'   ∩ '/:/:/*' => '/a/:/*'
 * '/a'     ∩ '/a/*'   => undefined   // a tail needs at least one more segment
 * ```
 */
export const intersectShapes = (a: Shape, b: Shape): Shape | undefined => {
  // Order so that `a` has the shorter fixed part.
  if (a.tokens.length > b.tokens.length) {
    const swap = a

    a = b
    b = swap
  }

  const fixedA = a.tokens.length
  const fixedB = b.tokens.length

  // Equal fixed parts need equal tails: '/a' never matches what '/a/*' matches.
  // A shorter fixed part needs a tail to cover the extra segments of the longer one.
  if (fixedA === fixedB ? a.tail !== b.tail : !a.tail) {
    return undefined
  }

  const tokens: Token[] = []

  for (let i = 0; i < fixedA; i++) {
    const tokenA = a.tokens[i]!
    const tokenB = b.tokens[i]!

    if (tokenA === null) {
      tokens.push(tokenB)
    } else if (tokenB === null || tokenA === tokenB) {
      tokens.push(tokenA)
    } else {
      return undefined
    }
  }

  for (let i = fixedA; i < fixedB; i++) {
    tokens.push(b.tokens[i]!)
  }

  return { tokens, tail: b.tail }
}

/**
 * `true` if every path matched by `inner` is matched by `outer`.
 */
export const containsShape = (outer: Shape, inner: Shape): boolean => {
  const intersection = intersectShapes(outer, inner)

  return intersection !== undefined && shapeId(intersection) === shapeId(inner)
}
