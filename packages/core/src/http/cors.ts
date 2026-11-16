/**
 * @module
 * CORS middleware.
 *
 * Follows Hono's `cors()` and the `cors` package Nest uses, with two differences:
 *
 * - only a real preflight (`OPTIONS` with `Access-Control-Request-Method`, as
 *   the Fetch spec defines it) is answered here; other `OPTIONS` requests reach
 *   the application and its own `OPTIONS` routes;
 * - `credentials: true` with `origin: '*'` is rejected when the middleware is
 *   created: browsers refuse that pair, so it could never work.
 *
 * Response headers are set in place: Bun's responses always have mutable headers.
 *
 * ```ts
 * cors({ origin: ['https://app.example.com'], credentials: true, maxAge: 600 })
 * ```
 */

import type { MiddlewareFunction } from './middleware.ts'

export interface CorsOptions {
  /**
   * Allowed origins: `'*'` (default), one origin, a list, or a predicate.
   * An allowed origin is echoed back; a refused one gets no CORS headers, so the browser blocks the response.
   */
  readonly origin?: '*' | string | readonly string[] | ((origin: string, req: Request) => boolean)
  /** Methods announced to preflights. */
  readonly methods?: readonly string[]
  /** Headers announced to preflights. Defaults to the ones the preflight asks for. */
  readonly allowedHeaders?: readonly string[]
  /** Response headers the browser exposes to scripts. */
  readonly exposedHeaders?: readonly string[]
  /** Allows cookies and `Authorization`; needs explicit origins. */
  readonly credentials?: boolean
  /** Seconds a browser may cache a preflight. */
  readonly maxAge?: number
}

const DEFAULT_METHODS = ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE']

const createOriginCheck = (origin: NonNullable<CorsOptions['origin']>): ((origin: string, req: Request) => boolean) => {
  if (typeof origin === 'function') {
    return origin
  }

  if (typeof origin === 'string') {
    return (requested) => requested === origin
  }

  const allowed = new Set(origin)

  return (requested) => allowed.has(requested)
}

const appendVary = (headers: Headers, value: string): void => {
  const current = headers.get('vary')

  if (current === null) {
    headers.set('vary', value)
  } else if (current !== '*' && !current.toLowerCase().split(/\s*,\s*/).includes(value.toLowerCase())) {
    headers.set('vary', `${current}, ${value}`)
  }
}

/**
 * Creates the CORS middleware. Throws a `TypeError` for options browsers would refuse.
 */
export const cors = (options: CorsOptions = {}): MiddlewareFunction => {
  const origin = options.origin ?? '*'
  const any = origin === '*'

  if (any && options.credentials === true) {
    throw new TypeError(
      "cors(): credentials cannot be used with origin '*', browsers reject that combination; list the allowed origins instead"
    )
  }

  const isAllowed = any ? () => true : createOriginCheck(origin)
  const methods = (options.methods ?? DEFAULT_METHODS).join(', ')
  const allowedHeaders = options.allowedHeaders?.join(', ')
  const exposedHeaders = options.exposedHeaders?.join(', ')
  const maxAge = options.maxAge === undefined ? undefined : String(options.maxAge)

  /** Headers every CORS response of an allowed origin gets. */
  const applyCommon = (headers: Headers, requested: string | null, req: Request): void => {
    if (requested !== null && isAllowed(requested, req)) {
      headers.set('access-control-allow-origin', any ? '*' : requested)

      if (options.credentials === true) {
        headers.set('access-control-allow-credentials', 'true')
      }
    }

    // The response depends on Origin as soon as it is not the same for every origin.
    if (!any) {
      appendVary(headers, 'Origin')
    }
  }

  const middleware: MiddlewareFunction = async (req, next) => {
    const requested = req.headers.get('origin')
    const preflight = req.method === 'OPTIONS' && requested !== null && req.headers.has('access-control-request-method')

    if (preflight) {
      const headers = new Headers()

      applyCommon(headers, requested, req)

      if (headers.has('access-control-allow-origin')) {
        headers.set('access-control-allow-methods', methods)

        const requestedHeaders = req.headers.get('access-control-request-headers')
        const allowHeaders = allowedHeaders ?? requestedHeaders ?? ''

        if (allowHeaders !== '') {
          headers.set('access-control-allow-headers', allowHeaders)
        }

        if (allowedHeaders === undefined && requestedHeaders !== null) {
          appendVary(headers, 'Access-Control-Request-Headers')
        }

        if (maxAge !== undefined) {
          headers.set('access-control-max-age', maxAge)
        }
      }

      return new Response(null, { status: 204, headers })
    }

    const response = await next()
    const headers = response.headers

    applyCommon(headers, requested, req)

    if (exposedHeaders !== undefined && headers.has('access-control-allow-origin')) {
      headers.set('access-control-expose-headers', exposedHeaders)
    }

    return response
  }

  // Listed as `cors` in the startup summary.
  return Object.defineProperty(middleware, 'name', { value: 'cors' })
}
