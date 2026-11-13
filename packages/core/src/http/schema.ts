/**
 * @module
 * Validation through Standard Schema: zod, valibot, arktype and others implement it.
 *
 * The interface is copied from the spec (https://standardschema.dev), as the
 * spec invites libraries to do, instead of depending on `@standard-schema/spec`.
 *
 * Errors follow Nest's `StandardSchemaValidationPipe`: one message per issue,
 * prefixed with its path (`address.city: Required`), the list capped so that a
 * hostile payload with thousands of issues cannot blow up the response.
 */

import { isThenable } from '../utils/promise.ts'
import { BadRequestException } from './exceptions.ts'

/** The Standard Schema interface, version 1. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output>
}

export declare namespace StandardSchemaV1 {
  interface Props<Input = unknown, Output = Input> {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown, options?: Options) => Result<Output> | Promise<Result<Output>>
    readonly types?: Types<Input, Output> | undefined
  }

  interface Options {
    readonly libraryOptions?: Record<string, unknown> | undefined
  }

  type Result<Output> = SuccessResult<Output> | FailureResult

  interface SuccessResult<Output> {
    readonly value: Output
    readonly issues?: undefined
  }

  interface FailureResult {
    readonly issues: readonly Issue[]
  }

  interface Issue {
    readonly message: string
    readonly path?: readonly (PropertyKey | PathSegment)[] | undefined
  }

  interface PathSegment {
    readonly key: PropertyKey
  }

  interface Types<Input = unknown, Output = Input> {
    readonly input: Input
    readonly output: Output
  }
}

/** Type a schema produces. */
export type InferOutput<S extends StandardSchemaV1> = NonNullable<S['~standard']['types']>['output']

/** Nest's default cap on the total length of validation messages. */
const MAX_MESSAGES_LENGTH = 1_000_000
const OMITTED = 'Further validation errors were omitted'

/** `true` for a Standard Schema. */
export const isStandardSchema = (value: unknown): value is StandardSchemaV1 =>
  typeof value === 'object' && value !== null && '~standard' in value

const formatIssues = (issues: readonly StandardSchemaV1.Issue[], prefix: string): string[] => {
  const messages: string[] = []
  let remaining = MAX_MESSAGES_LENGTH

  for (const issue of issues) {
    if (remaining <= 0) {
      messages.push(OMITTED)
      break
    }

    let path = prefix

    for (const segment of issue.path ?? []) {
      const key = typeof segment === 'object' ? segment.key : segment

      path = path === '' ? String(key) : `${path}.${String(key)}`
    }

    const message = path === '' ? issue.message : `${path}: ${issue.message}`

    remaining -= message.length
    messages.push(message)
  }

  return messages
}

/**
 * Validates `value`; returns the schema's output (schemas may transform) or
 * throws `BadRequestException` with the issues. `prefix` names the value in
 * messages (`id`, `page`); a body has none.
 */
export const validate = <S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
  prefix: string
): InferOutput<S> | Promise<InferOutput<S>> => {
  const result = schema['~standard'].validate(value)

  const settle = (outcome: StandardSchemaV1.Result<unknown>): InferOutput<S> => {
    if (outcome.issues !== undefined) {
      throw new BadRequestException(formatIssues(outcome.issues, prefix))
    }

    return outcome.value as InferOutput<S>
  }

  return isThenable(result) ? Promise.resolve(result).then(settle) : settle(result)
}

/**
 * Like `validate`, for values read synchronously (path, query, headers):
 * an asynchronous schema is a programming error there, reported as such.
 */
export const validateSync = <S extends StandardSchemaV1>(schema: S, value: unknown, prefix: string): InferOutput<S> => {
  const output = validate(schema, value, prefix)

  if (isThenable(output)) {
    throw new TypeError(`The schema for "${prefix}" validates asynchronously; only body schemas may be asynchronous`)
  }

  return output
}
