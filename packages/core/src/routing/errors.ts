/**
 * @module
 * Errors raised by the route compiler.
 */

import { hideFrameworkFrames } from '../utils/errors.ts'

/**
 * Reason of a `RouteError`.
 *
 * - `SYNTAX`: the path does not follow the route syntax.
 * - `INVALID_METHOD`: the method is not a valid HTTP token.
 * - `CONFLICT`: two routes match exactly the same requests.
 * - `TOO_COMPLEX`: the table expands into more than `MAX_NATIVE_ROUTES` native routes.
 */
export type RouteErrorCode = 'SYNTAX' | 'INVALID_METHOD' | 'CONFLICT' | 'TOO_COMPLEX'

/**
 * Error thrown by `compileRoutes`.
 *
 * Every problem in a route table is detected at startup, never while serving a request.
 */
export class RouteError extends Error {
  override readonly name = 'RouteError'

  constructor(
    readonly code: RouteErrorCode,
    message: string
  ) {
    super(message)
    hideFrameworkFrames(this)
  }
}
