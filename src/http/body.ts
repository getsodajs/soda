/**
 * @module
 * Reading a JSON request body safely.
 *
 * `JSON.parse('{"__proto__": {...}}')` creates an own `__proto__` key; code
 * merging that object later (`Object.assign`, spread into defaults, deep
 * merge) may then pollute `Object.prototype`. As Fastify's `secure-json-parse`
 * does, such bodies are rejected, not silently cleaned:
 *
 * 1. the raw text is tested with two regexes (which also catch `\u005f`-escaped
 *    keys, since `JSON.parse` decodes them into the same key); a normal body
 *    stops here and costs one plain `JSON.parse`;
 * 2. only a suspicious body is parsed with a reviver that rejects `__proto__`,
 *    and `constructor` holding an own `prototype`. A plain `constructor` field
 *    (`"constructor": "Ford"`) is legitimate and kept.
 */

import { BadRequestException, UnsupportedMediaTypeException } from './exceptions.ts'

const SUSPECT_PROTO =
  /"(?:_|\\u005[Ff])(?:_|\\u005[Ff])(?:p|\\u0070)(?:r|\\u0072)(?:o|\\u006[Ff])(?:t|\\u0074)(?:o|\\u006[Ff])(?:_|\\u005[Ff])(?:_|\\u005[Ff])"\s*:/
const SUSPECT_CONSTRUCTOR =
  /"(?:c|\\u0063)(?:o|\\u006[Ff])(?:n|\\u006[Ee])(?:s|\\u0073)(?:t|\\u0074)(?:r|\\u0072)(?:u|\\u0075)(?:c|\\u0063)(?:t|\\u0074)(?:o|\\u006[Ff])(?:r|\\u0072)"\s*:/
const BOM = 0xfeff
const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i

const FORBIDDEN = 'Request body contains a forbidden prototype property'

const rejectPrototypeKeys = (key: string, value: unknown): unknown => {
  if (key === '__proto__') {
    throw new BadRequestException(FORBIDDEN)
  }

  if (
    key === 'constructor' &&
    typeof value === 'object' &&
    value !== null &&
    Object.prototype.hasOwnProperty.call(value, 'prototype')
  ) {
    throw new BadRequestException(FORBIDDEN)
  }

  return value
}

/**
 * Parses JSON text, rejecting prototype pollution attempts.
 */
export const parseJson = (raw: string): unknown => {
  const text = raw.charCodeAt(0) === BOM ? raw.slice(1) : raw
  const suspicious = SUSPECT_PROTO.test(text) || SUSPECT_CONSTRUCTOR.test(text)

  try {
    return suspicious ? JSON.parse(text, rejectPrototypeKeys) : JSON.parse(text)
  } catch (error) {
    if (error instanceof BadRequestException) {
      throw error
    }

    throw new BadRequestException('Request body is not valid JSON', { cause: error })
  }
}

/**
 * Reads the body of `req` as JSON: `415` for another content type, `400` for
 * invalid JSON, `undefined` for an empty body (a schema decides if that is allowed).
 */
export const readJsonBody = async (req: Request): Promise<unknown> => {
  const type = req.headers.get('content-type')
  const text = await req.text()

  if (text === '') {
    return undefined
  }

  if (type === null || !JSON_TYPE.test(type)) {
    throw new UnsupportedMediaTypeException(`Expected a JSON body, got ${type ?? 'no content type'}`)
  }

  return parseJson(text)
}
