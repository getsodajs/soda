/**
 * @module
 * Rate limiting: `ThrottlerModule` sets the limits, `ThrottlerGuard` enforces
 * them, `@Throttle()` and `@SkipThrottle()` change them per route, as
 * `@nestjs/throttler` does.
 */

export { SkipThrottle, Throttle, ThrottlerGuard } from './guard.ts'
export type { ThrottleOverrides } from './guard.ts'
export { THROTTLER_OPTIONS, THROTTLER_STORAGE, ThrottlerModule } from './module.ts'
export type { ThrottlerLimit, ThrottlerModuleAsyncOptions, ThrottlerModuleOptions } from './module.ts'
export { MemoryThrottlerStorage } from './storage.ts'
export type { ThrottlerRecord, ThrottlerStorage } from './storage.ts'
