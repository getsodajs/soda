/**
 * @module
 * Request log middleware: one entry per request, once it is answered.
 *
 * ```ts
 * await createApp(AppModule, { middleware: [requestLog(), cors()] })
 * ```
 *
 * ```
 * 23:31:07 LOG HTTP  GET /v1/web/me status=200 ms=3
 * 23:31:09 WRN HTTP  POST /v1/web/auth/code status=422 ms=1
 * 23:31:12 ERR HTTP  DELETE /v1/admin/nodes/abc status=500 ms=12
 * ```
 *
 * Written through the application's `Logger`, with context `HTTP`: the level
 * follows the status (`log` below 400, `warn` for 4xx, `error` for 5xx), so
 * `level: 'warn'` keeps only the failures. As JSON lines, `status` and `ms`
 * are fields. The query is left out: it may carry tokens.
 *
 * Off unless listed. Put it first to time the whole request, other middleware included.
 */

import { Logger } from '../logger/index.ts'
import { inject } from '../di/index.ts'
import { pathOf } from '../utils/url.ts'
import { HttpException } from './exceptions.ts'
import type { MiddlewareFunction } from './middleware.ts'

/** Milliseconds, rounded to a tenth below 10. */
const elapsed = (since: number): number => {
  const ms = performance.now() - since

  return ms < 10 ? Math.round(ms * 10) / 10 : Math.round(ms)
}

const write = (logger: Logger, req: Request, status: number, since: number): void => {
  const message = `${req.method} ${pathOf(req.url)}`
  const data = { status, ms: elapsed(since) }

  if (status >= 500) {
    logger.error(message, data)
  } else if (status >= 400) {
    logger.warn(message, data)
  } else {
    logger.log(message, data)
  }
}

/** Creates the request log middleware. */
export const requestLog = (): MiddlewareFunction => {
  // One child per application logger: the same middleware may serve several applications.
  const children = new WeakMap<Logger, Logger>()

  const middleware: MiddlewareFunction = async (req, next) => {
    const since = performance.now()
    const root = inject(Logger)
    let logger = children.get(root)

    if (logger === undefined) {
      logger = root.child('HTTP')
      children.set(root, logger)
    }

    try {
      const response = await next()

      write(logger, req, response.status, since)

      return response
    } catch (error) {
      // Answered by the application's error handling, after this middleware.
      write(logger, req, error instanceof HttpException ? error.status : 500, since)

      throw error
    }
  }

  // Listed as `requestLog` in the startup summary.
  return Object.defineProperty(middleware, 'name', { value: 'requestLog' })
}
