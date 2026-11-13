/**
 * @module
 * `JwtModule`: provides a configured `JwtService`, like `@nestjs/jwt`.
 */

import { InjectionToken, Module, provide } from '../di/index.ts'
import type { Dependency, DependencyValues, DynamicModule, ModuleImport } from '../di/index.ts'
import { JwtService } from './service.ts'
import type { JwtOptions } from './service.ts'

export interface JwtModuleOptions extends JwtOptions {
  /** Cookie `JwtGuard` reads the token from when the request has no `Authorization` header. */
  readonly cookie?: string
}

export interface JwtModuleAsyncOptions<D extends readonly Dependency[]> {
  /** Modules providing what `inject` names. */
  readonly imports?: readonly ModuleImport[]
  readonly inject?: D
  readonly useFactory: (...args: DependencyValues<D>) => JwtModuleOptions | Promise<JwtModuleOptions>
  /** Makes `JwtService` visible in every module. */
  readonly global?: boolean
}

/** Options the module was registered with. */
export const JWT_OPTIONS = new InjectionToken<JwtModuleOptions>('JWT_OPTIONS')

const service = () => provide(JwtService, { inject: [JWT_OPTIONS], useFactory: (options) => new JwtService(options) })

/**
 * ```ts
 * @Module({ imports: [JwtModule.register({ secret: process.env.JWT_SECRET!, expiresIn: 900, global: true })] })
 * class AppModule {}
 *
 * JwtModule.registerAsync({ inject: [ConfigService], useFactory: (config) => ({ secret: config.get('JWT_SECRET') }) })
 * ```
 */
@Module({})
export class JwtModule {
  static register(options: JwtModuleOptions & { readonly global?: boolean }): DynamicModule {
    return {
      module: JwtModule,
      global: options.global ?? false,
      providers: [provide(JWT_OPTIONS, { useValue: options }), service()],
      exports: [JwtService, JWT_OPTIONS],
    }
  }

  static registerAsync<const D extends readonly Dependency[] = []>(options: JwtModuleAsyncOptions<D>): DynamicModule {
    return {
      module: JwtModule,
      global: options.global ?? false,
      imports: options.imports ?? [],
      providers: [provide<JwtModuleOptions, D>(JWT_OPTIONS, { inject: options.inject, useFactory: options.useFactory }), service()],
      exports: [JwtService, JWT_OPTIONS],
    }
  }
}
