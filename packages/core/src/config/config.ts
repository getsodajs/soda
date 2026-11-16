/**
 * @module
 * Configuration typed by a schema and validated at startup.
 *
 * What `@nestjs/config` does with `registerAs()` and a `validationSchema`,
 * typed by the schema instead of read with string keys. Bun already loads
 * `.env`, `.env.local` and `.env.<NODE_ENV>` into `process.env`.
 *
 * ```ts
 * export const AppConfig = defineConfig('app', z.object({
 *   PORT: z.coerce.number().default(3000),
 *   JWT_SECRET: z.string().min(32),
 * }))
 *
 * @Module({ imports: [ConfigModule.forRoot({ load: [AppConfig], global: true })] })
 * class AppModule {}
 *
 * class AuthService {
 *   readonly #config = inject(AppConfig) // { PORT: number; JWT_SECRET: string }
 * }
 * ```
 */

import { InjectionToken } from '../di/token.ts'
import { formatIssues } from '../http/schema.ts'
import type { InferOutput, StandardSchemaV1 } from '../http/schema.ts'
import { atSite, hideFrameworkFrames, quoted } from '../utils/errors.ts'

/** Environment variables, as in `process.env`. */
export type Environment = Readonly<Record<string, string | undefined>>

/** A configuration that does not match its schema; `issues` lists every problem. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError'

  constructor(
    readonly config: string,
    readonly issues: readonly string[]
  ) {
    super(`Invalid configuration "${config}":\n  ${issues.join('\n  ')}`)
    hideFrameworkFrames(this)
  }
}

/**
 * A configuration, and the DI token of its value: `inject(AppConfig)`.
 * `ConfigModule.forRoot()` loads it at startup; `load()` works without DI.
 */
export class Config<T> extends InjectionToken<T> {
  readonly #schema: StandardSchemaV1<unknown, T>
  readonly #source: (env: Environment) => unknown

  constructor(name: string, schema: StandardSchemaV1<unknown, T>, source: (env: Environment) => unknown) {
    super(name)
    this.#schema = schema
    this.#source = source
  }

  /** The value read from `env` and validated; throws a {@link ConfigError} listing every issue. */
  async load(env: Environment = process.env): Promise<T> {
    const result = await this.#schema['~standard'].validate(this.#source(env))

    if (result.issues !== undefined) {
      throw atSite(new ConfigError(this.description, formatIssues(result.issues, '')), { text: quoted('defineConfig(', this.description) })
    }

    return result.value
  }

  override toString(): string {
    return `Config(${this.description})`
  }
}

/**
 * Defines a configuration validated by `schema`. Its input is the environment,
 * or what `source` builds from it, for a nested configuration:
 *
 * ```ts
 * const DatabaseConfig = defineConfig('database', DatabaseSchema, (env) => ({
 *   url: env.DATABASE_URL,
 *   pool: { max: env.DATABASE_POOL_MAX },
 * }))
 * ```
 */
export const defineConfig = <S extends StandardSchemaV1>(
  name: string,
  schema: S,
  source: (env: Environment) => unknown = (env) => env
): Config<InferOutput<S>> => new Config(name, schema as StandardSchemaV1<unknown, InferOutput<S>>, source)
