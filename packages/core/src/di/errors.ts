/**
 * @module
 * Errors raised by the dependency injection container.
 */

import { hideFrameworkFrames } from '../utils/errors.ts'

/**
 * Reason of a `DiError`.
 *
 * - `NO_PROVIDER`: nothing visible from the requesting module provides the token.
 * - `AMBIGUOUS_PROVIDER`: two imported modules export different providers for the token.
 * - `CIRCULAR_DEPENDENCY`: a provider depends on itself, directly or not.
 * - `ASYNC_DEPENDENCY`: a class needs an asynchronous provider that is not created yet.
 * - `OUTSIDE_INJECTION_CONTEXT`: `inject()` called outside of a class being created by the container.
 * - `INVALID_PROVIDER`: a provider definition cannot be used.
 * - `DUPLICATE_PROVIDER`: a module provides the same token twice.
 * - `INVALID_MODULE`: an import is not a module.
 * - `INVALID_EXPORT`: a module exports something it neither provides nor imports.
 * - `CONTAINER_CLOSED`: the container is used after `close()`.
 */
export type DiErrorCode =
  | 'NO_PROVIDER'
  | 'AMBIGUOUS_PROVIDER'
  | 'CIRCULAR_DEPENDENCY'
  | 'ASYNC_DEPENDENCY'
  | 'OUTSIDE_INJECTION_CONTEXT'
  | 'INVALID_PROVIDER'
  | 'DUPLICATE_PROVIDER'
  | 'INVALID_MODULE'
  | 'INVALID_EXPORT'
  | 'CONTAINER_CLOSED'

/**
 * Error thrown by the container.
 *
 * Graph problems are reported by `createContainer`, at startup.
 */
export class DiError extends Error {
  override readonly name = 'DiError'

  constructor(
    readonly code: DiErrorCode,
    message: string,
    /** How to fix it, when there is one way: also the end of the message. */
    readonly fix?: string
  ) {
    super(fix === undefined ? message : `${message} ${fix}`)
    hideFrameworkFrames(this)
  }
}
