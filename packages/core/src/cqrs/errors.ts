/**
 * @module
 * Errors of the CQRS module.
 */

import { hideFrameworkFrames } from '../utils/errors.ts'

/**
 * Reason of a `CqrsError`.
 *
 * - `DUPLICATE_HANDLER`: a second handler for a command or a query, or a second handler decorator on one class.
 * - `NO_HANDLER`: a command or a query nothing handles.
 * - `HANDLER_NOT_PROVIDED`: the handler of a command or a query is in no module's `providers`.
 * - `AMBIGUOUS_HANDLER`: several modules provide the handler of a command or a query.
 * - `INVALID_MESSAGE`: what is executed or published is not an instance of a class.
 */
export type CqrsErrorCode = 'DUPLICATE_HANDLER' | 'NO_HANDLER' | 'HANDLER_NOT_PROVIDED' | 'AMBIGUOUS_HANDLER' | 'INVALID_MESSAGE'

/** Error of the CQRS module: a handler declared twice (when the class is defined), or missing (when executed). */
export class CqrsError extends Error {
  override readonly name = 'CqrsError'

  constructor(
    readonly code: CqrsErrorCode,
    message: string
  ) {
    super(message)
    hideFrameworkFrames(this)
  }
}
