/**
 * @module
 * Parsers for path, query and header values: the equivalents of Nest's
 * `ParseIntPipe`, `ParseFloatPipe`, `ParseBoolPipe`, `ParseUUIDPipe`.
 *
 * A Standard Schema (`z.coerce.number().min(1)`) works wherever a parser does.
 *
 * ```ts
 * ctx.param('id', int)                // number, 400 if not an integer
 * ctx.query('page', int.optional())   // number | undefined
 * ```
 */

import { BadRequestException } from './exceptions.ts'
import { isStandardSchema, validateSync } from './schema.ts'
import type { InferOutput, StandardSchemaV1 } from './schema.ts'

/**
 * Turns a raw string (`undefined` when absent) into a value, or throws an `HttpException`.
 */
export interface Parser<T> {
  readonly parse: (value: string | undefined, name: string) => T
  /** JSON Schema of the accepted strings, for API descriptions such as OpenAPI. */
  readonly jsonSchema?: Readonly<Record<string, unknown>>
  /** `false` when a missing value is accepted. */
  readonly required?: boolean
}

/** A parser of a value that must be present, and its variant accepting a missing one. */
export interface RequiredParser<T> extends Parser<T> {
  readonly required: true
  /** The same parser giving `undefined` for a missing value. Like Nest's `{ optional: true }`. */
  readonly optional: () => Parser<T | undefined>
}

/** What `param()`, `query()` and `header()` accept to convert a value. */
export type ValueParser<T> = Parser<T> | StandardSchemaV1<string | undefined, T>

/** Type a parser produces. */
export type Parsed<P> = P extends Parser<infer T> ? T : P extends StandardSchemaV1 ? InferOutput<P> : never

const INTEGER = /^-?\d+$/
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The `400` of a value that is missing or not what a parser expects. */
export const failure = (name: string, expected: string): BadRequestException =>
  new BadRequestException(`Validation failed for "${name}" (${expected} is expected)`)

/**
 * Builds a parser from `convert`, which gives `undefined` for an invalid value.
 * Its optional variant accepts a missing value; with `lenient`, an invalid one too.
 */
export const defineParser = <T>(
  expected: string,
  jsonSchema: Readonly<Record<string, unknown>>,
  convert: (value: string) => T | undefined,
  lenient = false
): RequiredParser<T> => {
  const variant = (required: boolean): Parser<T> => ({
    jsonSchema,
    required,
    parse: (value, name) => {
      const converted = value === undefined ? undefined : convert(value)

      if (converted === undefined && (required || (value !== undefined && !lenient))) {
        throw failure(name, expected)
      }

      return converted as T
    },
  })
  const optional = variant(false) as Parser<T | undefined>

  return { ...variant(true), required: true, optional: () => optional }
}

/**
 * Integer within `Number.MAX_SAFE_INTEGER`. Unlike Nest's `ParseIntPipe`,
 * `'99999999999999999999'` is rejected instead of being silently rounded.
 */
export const int: RequiredParser<number> = defineParser('integer string', { type: 'integer' }, (value) => {
  const number = INTEGER.test(value) ? Number(value) : Number.NaN

  return Number.isSafeInteger(number) ? number : undefined
})

/** Finite decimal number: `'1.5'`, `'-2'`, `'1e3'`. */
export const number: RequiredParser<number> = defineParser('numeric string', { type: 'number' }, (value) => {
  const parsed = NUMBER.test(value) ? Number(value) : Number.NaN

  return Number.isFinite(parsed) ? parsed : undefined
})

/** `'true'` or `'false'`. */
export const boolean: RequiredParser<boolean> = defineParser('boolean string', { type: 'boolean' }, (value) =>
  value === 'true' ? true : value === 'false' ? false : undefined
)

/** UUID of any version, case-insensitive. */
export const uuid: RequiredParser<string> = defineParser('UUID string', { type: 'string', format: 'uuid' }, (value) =>
  UUID.test(value) ? value : undefined
)

/**
 * Applies a parser or a synchronous Standard Schema to a raw value.
 */
export const applyParser = <P extends ValueParser<unknown>>(parser: P, value: string | undefined, name: string): Parsed<P> =>
  (isStandardSchema(parser) ? validateSync(parser, value, name) : (parser as Parser<unknown>).parse(value, name)) as Parsed<P>
