/**
 * @module
 * Application middleware: runs around every request, before routing.
 *
 * Unlike guards and interceptors, which belong to a route, middleware sees
 * every request: unknown paths (404), wrong methods (405), CORS preflights.
 * That is where CORS, request ids, access logs or compression belong.
 *
 * ```ts
 * const requestId: MiddlewareFunction = async (req, next) => {
 *   const response = await next()
 *
 *   response.headers.set('x-request-id', crypto.randomUUID())
 *
 *   return response
 * }
 *
 * await createApp(AppModule, { middleware: [cors({ origin: 'https://app.example.com' }), requestId] })
 * ```
 *
 * As guards: a class is created once by the container (root module) and gets
 * lifecycle hooks, a function runs where `inject()` works, an instance is used as is.
 */

import type { Constructor } from '../di/index.ts'
import type { NativeHandler } from '../routing/index.ts'

/** Continues with the next middleware, then the route. */
export type Next = () => Promise<Response>

/** Class middleware. Like Nest's `NestMiddleware`, for the Fetch API. */
export interface NestMiddleware {
  use(req: Request, next: Next): Response | Promise<Response>
}

/** Function middleware; `inject()` works inside it, before the first `await`. */
export type MiddlewareFunction = (req: Request, next: Next) => Response | Promise<Response>

/** What `middleware` accepts. */
export type Middleware = Constructor<NestMiddleware> | NestMiddleware | MiddlewareFunction

type Step = (req: Request, next: Next) => Response | Promise<Response>

/** Runs a step, turning a synchronous throw into a rejection. */
const settle = (step: () => Response | Promise<Response>): Promise<Response> => {
  try {
    return Promise.resolve(step())
  } catch (error) {
    return Promise.reject(error)
  }
}

/**
 * Turns middleware declarations into steps. Classes are created now, inside
 * `runInContext`, and passed to `onCreate` for their lifecycle hooks.
 */
export const resolveMiddleware = (
  middleware: readonly Middleware[],
  runInContext: <R>(fn: () => R) => R,
  onCreate: (instance: unknown) => void
): Step[] => {
  const steps: Step[] = []

  for (const entry of middleware) {
    if (typeof entry === 'function' && typeof (entry.prototype as Record<string, unknown> | undefined)?.use === 'function') {
      const instance = runInContext(() => new (entry as Constructor<NestMiddleware>)())

      onCreate(instance)
      steps.push((req, next) => instance.use(req, next))
    } else if (typeof entry === 'function') {
      const fn = entry as MiddlewareFunction

      steps.push((req, next) => runInContext(() => fn(req, next)))
    } else if (typeof entry === 'object' && entry !== null && typeof entry.use === 'function') {
      steps.push((req, next) => entry.use(req, next))
    } else {
      throw new TypeError(`Invalid middleware: ${String(entry)} is neither a function nor an object with use()`)
    }
  }

  return steps
}

/**
 * Wraps `handler` with the middleware steps, first one outermost.
 * Errors of middleware go to `onError`, which builds the response.
 */
export const withMiddleware = <R extends Request>(
  steps: readonly Step[],
  handler: (req: R) => Response | Promise<Response>,
  onError: (error: unknown, req: Request) => Response
): ((req: R) => Promise<Response>) => {
  const count = steps.length

  return (req) => {
    const call = (index: number): Promise<Response> =>
      index === count ? settle(() => handler(req)) : settle(() => steps[index]!(req, () => call(index + 1)))

    return call(0).catch((error: unknown) => onError(error, req))
  }
}

/**
 * Applies middleware to every native route and to the fallback of a compiled table.
 * Without middleware, the table is returned unchanged: no wrapper on the request path.
 */
export const applyMiddleware = (
  steps: readonly Step[],
  routes: Record<string, NativeHandler>,
  fetch: (req: Request) => Response | Promise<Response>,
  onError: (error: unknown, req: Request) => Response
): { routes: Record<string, NativeHandler>; fetch: (req: Request) => Response | Promise<Response> } => {
  if (steps.length === 0) {
    return { routes, fetch }
  }

  const wrapped: Record<string, NativeHandler> = {}

  for (const key of Object.keys(routes)) {
    wrapped[key] = withMiddleware(steps, routes[key]!, onError)
  }

  return { routes: wrapped, fetch: withMiddleware(steps, fetch, onError) }
}
