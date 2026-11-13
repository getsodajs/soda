/**
 * @module
 * Public types and constants of the route compiler.
 */

/**
 * Method name that matches any HTTP method.
 * A route registered for a concrete method always wins over `ALL` on the same path.
 */
export const METHOD_ALL = 'ALL'

/**
 * Default upper bound for the number of native routes produced by the compiler.
 *
 * Overlapping routes (`/a/:id` and `/:tenant/b`) are materialised into extra
 * native routes (`/a/b`) at startup, so a pathological table could grow
 * quadratically. Exceeding the limit is reported as a `TOO_COMPLEX` error
 * instead of silently consuming memory and startup time.
 */
export const MAX_NATIVE_ROUTES = 100_000

/**
 * Map of decoded route parameters.
 *
 * ```ts
 * // '/users/:id' matched against '/users/42'
 * { id: '42' }
 * ```
 */
export type Params = Record<string, string>

/**
 * Route handler.
 *
 * `params` may be the very object Bun put on `req.params`: treat it as read-only.
 */
export type Handler = (req: Request, params: Params) => Response | Promise<Response>

/**
 * Route definition.
 *
 * Path syntax, every special form occupies a whole segment:
 *
 * ```ts
 * '/users/me'         // static
 * '/users/:id'        // parameter, one non-empty segment
 * '/users/:id{\\d+}'  // parameter constrained by a regex (tested on the decoded value)
 * '/users/:id?'       // optional parameter, only trailing parameters can be optional
 * '/files/*'          // wildcard, matches '/files' and everything below it
 * '/files/*path'      // named wildcard, `params.path` is the decoded remainder
 * ```
 */
export interface RouteDefinition {
  /** HTTP method, case-insensitive, or `ALL`. */
  readonly method: string
  readonly path: string
  readonly handler: Handler
  /** Shown in startup errors, e.g. `UsersController.findOne`. */
  readonly name?: string
}

/**
 * Options of `compileRoutes`.
 */
export interface CompileOptions {
  /** Called when no route matches the path. Defaults to a plain `404 Not Found`. */
  readonly notFound?: (req: Request) => Response | Promise<Response>
  /** Upper bound for the number of native routes. Defaults to `MAX_NATIVE_ROUTES`. */
  readonly maxNativeRoutes?: number
}

/**
 * Handler of a single native route, as accepted by `Bun.serve({ routes })`.
 */
export type NativeHandler = (req: Bun.BunRequest) => Response | Promise<Response>

/**
 * Result of `compileRoutes`, ready to be spread into `Bun.serve()` or `server.reload()`.
 *
 * ```ts
 * const server = Bun.serve({ port: 3000, ...compileRoutes(definitions) })
 * server.reload(compileRoutes(nextDefinitions))
 * ```
 */
export interface CompiledRoutes {
  readonly routes: Record<string, NativeHandler>
  readonly fetch: (req: Request) => Response | Promise<Response>
}
