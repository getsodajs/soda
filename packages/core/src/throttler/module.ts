/**
 * @module
 * `ThrottlerModule`: the limits `ThrottlerGuard` enforces, like `@nestjs/throttler`.
 */

import { InjectionToken, Module, provide } from '../di/index.ts'
import type { Dependency, DependencyValues, DynamicModule, ModuleImport } from '../di/index.ts'
import type { Context } from '../http/context.ts'
import { MemoryThrottlerStorage } from './storage.ts'
import type { ThrottlerStorage } from './storage.ts'

/** One limit: at most `limit` requests per `ttl` milliseconds for each client, on each route. */
export interface ThrottlerLimit {
  /** Name for `@Throttle()` and `@SkipThrottle()`, and suffix of the headers; defaults to `default`. */
  readonly name?: string
  readonly limit: number
  /** Length of a window, in milliseconds. */
  readonly ttl: number
  /** How long a client past the limit is refused, in milliseconds; defaults to the rest of the window. */
  readonly blockDuration?: number
}

export interface ThrottlerModuleOptions {
  /** Every limit applies: `[{ name: 'burst', ttl: 1000, limit: 5 }, { ttl: 60_000, limit: 100 }]`. */
  readonly throttlers: readonly ThrottlerLimit[]
  /** Defaults to memory: right for one instance of the application. */
  readonly storage?: ThrottlerStorage
  /**
   * Who is counted; defaults to `ctx.ip`. Behind a proxy that is the proxy:
   * read the client from the header the proxy sets, `x-forwarded-for`.
   * `undefined` lets the request through uncounted.
   */
  readonly tracker?: (ctx: Context) => string | undefined | Promise<string | undefined>
  /** Requests to let through uncounted, such as health checks. */
  readonly skip?: (ctx: Context) => boolean | Promise<boolean>
  /** Send `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`; defaults to `true`. */
  readonly headers?: boolean
}

export interface ThrottlerModuleAsyncOptions<D extends readonly Dependency[]> {
  /** Modules providing what `inject` names. */
  readonly imports?: readonly ModuleImport[]
  readonly inject?: D
  readonly useFactory: (...args: DependencyValues<D>) => ThrottlerModuleOptions | Promise<ThrottlerModuleOptions>
}

/** Options the module was registered with. */
export const THROTTLER_OPTIONS = new InjectionToken<ThrottlerModuleOptions>('THROTTLER_OPTIONS')

/** The storage of the options, or one in memory, stopped with the application. */
export const THROTTLER_STORAGE = new InjectionToken<ThrottlerStorage>('THROTTLER_STORAGE')

const storage = () =>
  provide(THROTTLER_STORAGE, { inject: [THROTTLER_OPTIONS], useFactory: (options) => options.storage ?? new MemoryThrottlerStorage() })

/**
 * Global, as in Nest: `ThrottlerGuard` finds the limits in every module.
 *
 * ```ts
 * @Module({ imports: [ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 100 }] })] })
 * class AppModule {}
 *
 * await createApp(AppModule, { guards: [ThrottlerGuard] })
 * ```
 */
@Module({})
export class ThrottlerModule {
  static forRoot(options: ThrottlerModuleOptions): DynamicModule {
    return {
      module: ThrottlerModule,
      global: true,
      providers: [provide(THROTTLER_OPTIONS, { useValue: options }), storage()],
      exports: [THROTTLER_OPTIONS, THROTTLER_STORAGE],
    }
  }

  static forRootAsync<const D extends readonly Dependency[] = []>(options: ThrottlerModuleAsyncOptions<D>): DynamicModule {
    return {
      module: ThrottlerModule,
      global: true,
      imports: options.imports ?? [],
      providers: [provide<ThrottlerModuleOptions, D>(THROTTLER_OPTIONS, { inject: options.inject, useFactory: options.useFactory }), storage()],
      exports: [THROTTLER_OPTIONS, THROTTLER_STORAGE],
    }
  }
}
