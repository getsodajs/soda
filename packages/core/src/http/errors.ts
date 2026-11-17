/**
 * @module
 * Errors raised while declaring and collecting controllers.
 */

import { hideFrameworkFrames } from '../utils/errors.ts'

/**
 * Reason of a `ControllerError`.
 *
 * - `NOT_A_CONTROLLER`: a module lists a class without `@Controller()` in `controllers`.
 * - `INVALID_HANDLER`: a route decorator is placed on something that is not a public instance method.
 * - `INVALID_STATUS`: `@HttpCode()` with a status a `Response` cannot have, or twice on one method.
 * - `INVALID_HEADER`: `@Header()` with a name or value `Headers` rejects.
 * - `UNKNOWN_PARAM`: `param('x')` in an argument list names no parameter of the route path.
 * - `INVALID_PATH`: a WebSocket gateway path that is not static.
 * - `DUPLICATE_ROUTE`: a gateway on the path of another gateway or route.
 * - `INVALID_ARGUMENT`: an argument where it cannot be read, such as `data()` on a route or `body()` in a gateway.
 * - `INVALID_RETURNS`: `@Returns()` without a schema, twice on one method, or on an `@Sse()` route.
 */
export type ControllerErrorCode =
  | 'NOT_A_CONTROLLER'
  | 'INVALID_HANDLER'
  | 'INVALID_STATUS'
  | 'INVALID_HEADER'
  | 'UNKNOWN_PARAM'
  | 'INVALID_PATH'
  | 'DUPLICATE_ROUTE'
  | 'INVALID_ARGUMENT'
  | 'INVALID_RETURNS'

/**
 * Error thrown by the controller decorators (when the class is defined) and by
 * `controllerRoutes` (at startup), never while serving a request.
 */
export class ControllerError extends Error {
  override readonly name = 'ControllerError'

  constructor(
    readonly code: ControllerErrorCode,
    message: string
  ) {
    super(message)
    hideFrameworkFrames(this)
  }
}
