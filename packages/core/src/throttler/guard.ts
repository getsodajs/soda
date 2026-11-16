/**
 * @module
 * `ThrottlerGuard`, `@Throttle()` and `@SkipThrottle()`, as in `@nestjs/throttler`.
 */

import { inject } from '../di/index.ts'
import type { Context } from '../http/context.ts'
import { createDecorator } from '../http/enhancers.ts'
import type { CanActivate, ClassOrMethodDecorator } from '../http/enhancers.ts'
import { TooManyRequestsException } from '../http/exceptions.ts'
import { THROTTLER_OPTIONS, THROTTLER_STORAGE } from './module.ts'
import type { ThrottlerLimit } from './module.ts'

const DEFAULT = 'default'

/** Changes to the limits of a route or a controller, by limit name. */
export type ThrottleOverrides = Readonly<Record<string, Partial<Omit<ThrottlerLimit, 'name'>>>>

const ThrottleMetadata = createDecorator<ThrottleOverrides>('Throttle')
const SkipThrottleMetadata = createDecorator<Readonly<Record<string, boolean>>>('SkipThrottle')

/**
 * Other limits for a controller or a route, the method's over the class's.
 *
 * ```ts
 * @Post('login')
 * @Throttle({ default: { limit: 5, ttl: 60_000 } })
 * login() {}
 * ```
 */
export const Throttle = (overrides: ThrottleOverrides): ClassOrMethodDecorator => ThrottleMetadata(overrides)

/**
 * No limit for a controller or a route: all of them, or those named.
 * `@SkipThrottle({ default: false })` on a method lifts a skip of its class.
 */
export const SkipThrottle = (skip: Readonly<Record<string, boolean>> = { [DEFAULT]: true }): ClassOrMethodDecorator =>
  SkipThrottleMetadata(skip)

/** `X-RateLimit-Limit`, or `X-RateLimit-Limit-burst` for a limit named `burst`. */
const headerName = (base: string, name: string): string => (name === DEFAULT ? base : `${base}-${name}`)

/**
 * Counts the requests of each client on each route, and refuses those past a
 * limit of `ThrottlerModule` with a `429` and `Retry-After`. Use it globally,
 * `createApp(AppModule, { guards: [ThrottlerGuard] })`, or with `@UseGuards()`.
 *
 * A route is counted per controller and method, as in Nest: `login` and
 * `register` each have their own limit.
 */
export class ThrottlerGuard implements CanActivate {
  readonly #options = inject(THROTTLER_OPTIONS)
  readonly #storage = inject(THROTTLER_STORAGE)

  async canActivate(ctx: Context): Promise<boolean> {
    const options = this.#options

    if ((await options.skip?.(ctx)) === true) {
      return true
    }

    const tracker = options.tracker === undefined ? ctx.ip : await options.tracker(ctx)

    if (tracker === undefined) {
      return true
    }

    const overrides = ctx.metadata(ThrottleMetadata)
    const skipped = ctx.metadata(SkipThrottleMetadata)

    for (const throttler of options.throttlers) {
      const name = throttler.name ?? DEFAULT

      if (skipped?.[name] !== true) {
        await this.#count(ctx, tracker, name, { ...throttler, ...overrides?.[name] })
      }
    }

    return true
  }

  async #count(ctx: Context, tracker: string, name: string, limit: ThrottlerLimit): Promise<void> {
    const { route } = ctx
    const key = `${route.controller.name}.${route.handler}:${name}:${tracker}`
    const record = await this.#storage.increment(key, limit.ttl, limit.limit, limit.blockDuration ?? limit.ttl)

    if (record.isBlocked) {
      throw new TooManyRequestsException('Too Many Requests', {
        headers: { [headerName('retry-after', name)]: String(Math.ceil(record.timeToBlockExpire / 1000)) },
      })
    }

    if (this.#options.headers !== false) {
      const headers = ctx.responseHeaders

      headers.set(headerName('x-ratelimit-limit', name), String(limit.limit))
      headers.set(headerName('x-ratelimit-remaining', name), String(Math.max(0, limit.limit - record.totalHits)))
      headers.set(headerName('x-ratelimit-reset', name), String(Math.ceil(record.timeToExpire / 1000)))
    }
  }
}
