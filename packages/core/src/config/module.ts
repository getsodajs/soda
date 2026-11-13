/**
 * @module
 * `ConfigModule`: loads configurations at startup, like `ConfigModule.forRoot()` of `@nestjs/config`.
 */

import { Module, provide } from '../di/index.ts'
import type { DynamicModule } from '../di/index.ts'
import type { Config, Environment } from './config.ts'

export interface ConfigModuleOptions {
  /** Configurations to load and provide. */
  readonly load: readonly Config<unknown>[]
  /** Makes them injectable in every module. Defaults to `false`, as in Nest. */
  readonly global?: boolean
  /** Where variables come from, read when the container starts. Defaults to `process.env`. */
  readonly env?: Environment
}

/**
 * ```ts
 * @Module({ imports: [ConfigModule.forRoot({ load: [AppConfig, DatabaseConfig], global: true })] })
 * class AppModule {}
 * ```
 *
 * Each configuration is loaded when the container starts; an invalid one
 * fails the startup with a `ConfigError` listing all its issues. Tests
 * replace a value with `overrides: [provide(AppConfig, { useValue })]`, and
 * the replaced configuration is not loaded.
 */
@Module({})
export class ConfigModule {
  static forRoot(options: ConfigModuleOptions): DynamicModule {
    return {
      module: ConfigModule,
      global: options.global ?? false,
      providers: options.load.map((config) => provide(config, { useFactory: () => config.load(options.env) })),
      exports: options.load,
    }
  }
}
