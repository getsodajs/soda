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

import { BadRequestException, PayloadTooLargeException, UnsupportedMediaTypeException } from './exceptions.ts'

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

const FORM_TYPE = /^(?:multipart\/form-data|application\/x-www-form-urlencoded)(?:\s*;|$)/i
const ARRAY_SUFFIX = '[]'

/** Parsed form data, as `Request.formData()` gives it. */
type FormBody = Awaited<ReturnType<Request['formData']>>

/** A form value: text, or a file of a multipart body. */
export type FormValue = string | File

/** Fields of a form; repeated fields and fields named `name[]` are arrays. */
export type FormFields = Record<string, FormValue | FormValue[]>

/**
 * Turns form data into an object without prototype.
 *
 * ```ts
 * 'a=1&a=2'      => { a: ['1', '2'] }   // repeated fields are kept, not overwritten
 * 'tags[]=x'     => { tags: ['x'] }     // `[]` always gives an array, even with one value
 * 'name=Ann'     => { name: 'Ann' }
 * ```
 */
const toFields = (data: FormBody): FormFields => {
  const fields: FormFields = Object.create(null)

  for (const [rawKey, value] of data) {
    const array = rawKey.endsWith(ARRAY_SUFFIX)
    const key = array ? rawKey.slice(0, -ARRAY_SUFFIX.length) : rawKey
    const current = fields[key]

    if (current === undefined) {
      fields[key] = array ? [value] : value
    } else if (Array.isArray(current)) {
      current.push(value)
    } else {
      fields[key] = [current, value]
    }
  }

  return fields
}

/**
 * Limits of a form body, beyond the server's `maxRequestBodySize`; each one
 * exceeded is a `413`. Like the `limits` of multer and `@fastify/multipart`.
 */
export interface FormLimits {
  /** Bytes of the whole body, refused as soon as they are exceeded, before the body is read entirely. */
  readonly maxBodySize?: number
  /** Bytes of each file. */
  readonly maxFileSize?: number
  /** Number of files. */
  readonly maxFiles?: number
  /** Number of fields, files included. */
  readonly maxFields?: number
}

/** The body, read up to `max` bytes: `413` as soon as it is larger. */
const readUpTo = async (req: Request, max: number): Promise<Uint8Array<ArrayBuffer>> => {
  if (Number(req.headers.get('content-length') ?? 0) > max) {
    throw new PayloadTooLargeException(`Request body is larger than ${max} bytes`)
  }

  if (req.body === null) {
    return new Uint8Array()
  }

  const chunks: Uint8Array[] = []
  let size = 0

  for await (const chunk of req.body) {
    size += chunk.byteLength

    if (size > max) {
      throw new PayloadTooLargeException(`Request body is larger than ${max} bytes`)
    }

    chunks.push(chunk)
  }

  return Buffer.concat(chunks)
}

/** `413` for the first limit the form exceeds. */
const checkLimits = (data: FormBody, limits: FormLimits): void => {
  const { maxFileSize = Infinity, maxFiles = Infinity, maxFields = Infinity } = limits
  let fields = 0
  let files = 0

  for (const [name, value] of data) {
    fields++

    if (fields > maxFields) {
      throw new PayloadTooLargeException(`Form has more than ${maxFields} fields`)
    }

    if (typeof value !== 'string') {
      files++

      if (files > maxFiles) {
        throw new PayloadTooLargeException(`Form has more than ${maxFiles} files`)
      }

      if (value.size > maxFileSize) {
        throw new PayloadTooLargeException(`File "${name}" is larger than ${maxFileSize} bytes`)
      }
    }
  }
}

/**
 * Reads a `multipart/form-data` or `application/x-www-form-urlencoded` body:
 * `415` for another content type, `400` for a malformed body, `413` past a limit.
 *
 * Kept apart from JSON on purpose: an HTML form on another site can post a form
 * without a CORS preflight, a JSON body cannot. A JSON endpoint must not accept forms.
 *
 * `File.type` is the type the client declared, not checked against the content.
 */
export const readFormBody = async (req: Request, limits: FormLimits = {}): Promise<FormFields> => {
  const type = req.headers.get('content-type')

  if (type === null || !FORM_TYPE.test(type)) {
    throw new UnsupportedMediaTypeException(`Expected a form body, got ${type ?? 'no content type'}`)
  }

  // Parsed from the bytes read so far, as only a whole body can be parsed.
  const source =
    limits.maxBodySize === undefined ? req : new Response(await readUpTo(req, limits.maxBodySize), { headers: { 'content-type': type } })
  let data: FormBody

  try {
    data = await source.formData()
  } catch (error) {
    throw new BadRequestException('Request body is not a valid form', { cause: error })
  }

  checkLimits(data, limits)

  return toFields(data)
}
