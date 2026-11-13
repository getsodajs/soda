/**
 * @module
 * Errors raised while declaring and collecting controllers.
 */

/**
 * Reason of a `ControllerError`.
 *
 * - `NOT_A_CONTROLLER`: a module lists a class without `@Controller()` in `controllers`.
 * - `INVALID_HANDLER`: a route decorator is placed on something that is not a public instance method.
 * - `INVALID_STATUS`: `@HttpCode()` with a status a `Response` cannot have, or twice on one method.
 * - `INVALID_HEADER`: `@Header()` with a name or value `Headers` rejects.
 * - `UNKNOWN_PARAM`: `param('x')` in an argument list names no parameter of the route path.
 */
export type ControllerErrorCode =
  | 'NOT_A_CONTROLLER'
  | 'INVALID_HANDLER'
  | 'INVALID_STATUS'
  | 'INVALID_HEADER'
  | 'UNKNOWN_PARAM'

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
  }
}
