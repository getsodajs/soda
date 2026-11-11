/**
 * @module
 * Parsers for path, query and header values: the equivalents of Nest's
 * `ParseIntPipe`, `ParseFloatPipe`, `ParseBoolPipe`, `ParseUUIDPipe`.
 *
 * A Standard Schema (`z.coerce.number().min(1)`) works wherever a parser does.
 *
 * ```ts
 * ctx.param('id', int())                    // number, 400 if not an integer
 * ctx.query('page', int({ optional: true }))  // number | undefined
 * ```
 */

import { BadRequestException } from './exceptions'
import { isStandardSchema, validateSync } from './schema'
import type { InferOutput, StandardSchemaV1 } from './schema'

/**
 * Turns a raw string (`undefined` when absent) into a value, or throws an `HttpException`.
 */
export interface Parser<T> {
  readonly parse: (value: string | undefined, name: string) => T
}

/** What `param()`, `query()` and `header()` accept to convert a value. */
export type ValueParser<T> = Parser<T> | StandardSchemaV1<string | undefined, T>

/** Type a parser produces. */
export type Parsed<P> = P extends Parser<infer T> ? T : P extends StandardSchemaV1 ? InferOutput<P> : never

export interface ParserOptions {
  /** Accept a missing value, giving `undefined`. Like Nest's `{ optional: true }`. */
  readonly optional?: boolean
}

type Result<T, O extends ParserOptions> = O extends { readonly optional: true } ? T | undefined : T

const INTEGER = /^-?\d+$/
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const failure = (name: string, expected: string): BadRequestException =>
  new BadRequestException(`Validation failed for "${name}" (${expected} is expected)`)

const createParser = <T>(
  expected: string,
  convert: (value: string) => T | undefined,
  options: ParserOptions
): Parser<T | undefined> => ({
  parse: (value, name) => {
    if (value === undefined) {
      if (options.optional === true) {
        return undefined
      }

      throw failure(name, expected)
    }

    const converted = convert(value)

    if (converted === undefined) {
      throw failure(name, expected)
    }

    return converted
  },
})

/**
 * Integer within `Number.MAX_SAFE_INTEGER`. Unlike Nest's `ParseIntPipe`,
 * `'99999999999999999999'` is rejected instead of being silently rounded.
 */
export const int = <const O extends ParserOptions = {}>(options?: O): Parser<Result<number, O>> =>
  createParser(
    'integer string',
    (value) => {
      const number = INTEGER.test(value) ? Number(value) : Number.NaN

      return Number.isSafeInteger(number) ? number : undefined
    },
    options ?? {}
  ) as Parser<Result<number, O>>

/** Finite decimal number: `'1.5'`, `'-2'`, `'1e3'`. */
export const number = <const O extends ParserOptions = {}>(options?: O): Parser<Result<number, O>> =>
  createParser(
    'numeric string',
    (value) => {
      const parsed = NUMBER.test(value) ? Number(value) : Number.NaN

      return Number.isFinite(parsed) ? parsed : undefined
    },
    options ?? {}
  ) as Parser<Result<number, O>>

/** `'true'` or `'false'`. */
export const boolean = <const O extends ParserOptions = {}>(options?: O): Parser<Result<boolean, O>> =>
  createParser('boolean string', (value) => (value === 'true' ? true : value === 'false' ? false : undefined), options ?? {}) as Parser<
    Result<boolean, O>
  >

/** UUID of any version, case-insensitive. */
export const uuid = <const O extends ParserOptions = {}>(options?: O): Parser<Result<string, O>> =>
  createParser('UUID string', (value) => (UUID.test(value) ? value : undefined), options ?? {}) as Parser<Result<string, O>>

/**
 * Applies a parser or a synchronous Standard Schema to a raw value.
 */
export const applyParser = <P extends ValueParser<unknown>>(parser: P, value: string | undefined, name: string): Parsed<P> =>
  (isStandardSchema(parser) ? validateSync(parser, value, name) : (parser as Parser<unknown>).parse(value, name)) as Parsed<P>
