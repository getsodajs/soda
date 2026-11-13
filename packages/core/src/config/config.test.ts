import { describe, expect, it } from 'bun:test'
import { createContainer, inject, Module, provide } from '../di/index.ts'
import type { StandardSchemaV1 } from '../http/schema.ts'
import { ConfigError, defineConfig } from './config.ts'
import { ConfigModule } from './module.ts'

interface App {
  readonly port: number
  readonly secret: string
}

/** What `z.object({ PORT: z.coerce.number().default(3000), SECRET: z.string().min(8) })` checks. */
const AppSchema: StandardSchemaV1<unknown, App> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) => {
      const env = value as Record<string, string | undefined>
      const port = Number(env.PORT ?? 3000)
      const issues: StandardSchemaV1.Issue[] = []

      if (!Number.isInteger(port)) {
        issues.push({ message: 'Expected an integer', path: ['PORT'] })
      }

      if (env.SECRET === undefined || env.SECRET.length < 8) {
        issues.push({ message: 'Expected at least 8 characters', path: ['SECRET'] })
      }

      return issues.length > 0 ? { issues } : { value: { port, secret: env.SECRET! } }
    },
  },
}

const AppConfig = defineConfig('app', AppSchema)

describe('defineConfig', () => {
  it('reads the environment through the schema, typed by its output', async () => {
    const config: App = await AppConfig.load({ PORT: '8080', SECRET: 'long enough', OTHER: 'ignored' })

    expect(config).toEqual({ port: 8080, secret: 'long enough' })
    expect(await AppConfig.load({ SECRET: 'long enough' })).toEqual({ port: 3000, secret: 'long enough' })
  })

  it('builds nested input from the environment', async () => {
    const Database = defineConfig('database', AppSchema, (env) => ({ PORT: env.DB_PORT, SECRET: env.DB_PASSWORD }))

    expect(await Database.load({ DB_PORT: '5432', DB_PASSWORD: 'password' })).toEqual({ port: 5432, secret: 'password' })
  })

  it('reports every issue at once', async () => {
    const error = await AppConfig.load({ PORT: 'eighty' }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ConfigError)
    expect((error as ConfigError).issues).toEqual(['PORT: Expected an integer', 'SECRET: Expected at least 8 characters'])
    expect((error as ConfigError).message).toBe(
      'Invalid configuration "app":\n  PORT: Expected an integer\n  SECRET: Expected at least 8 characters'
    )
  })
})

describe('ConfigModule', () => {
  class Server {
    readonly config = inject(AppConfig)
  }

  @Module({ providers: [Server], exports: [Server] })
  class ServerModule {}

  it('provides the configurations, globally when asked', async () => {
    @Module({ imports: [ConfigModule.forRoot({ load: [AppConfig], global: true, env: { SECRET: 'long enough' } }), ServerModule] })
    class AppModule {}

    const container = await createContainer(AppModule)

    expect(container.get(Server).config).toEqual({ port: 3000, secret: 'long enough' })
  })

  it('is visible only to importers by default', async () => {
    @Module({ imports: [ConfigModule.forRoot({ load: [AppConfig], env: { SECRET: 'long enough' } }), ServerModule] })
    class AppModule {}

    await expect(createContainer(AppModule)).rejects.toThrow('Config(app)')
  })

  it('fails the startup on an invalid configuration, and skips overridden ones', async () => {
    @Module({ imports: [ConfigModule.forRoot({ load: [AppConfig], global: true, env: {} }), ServerModule] })
    class AppModule {}

    const failure = await createContainer(AppModule).catch((caught: unknown) => caught)
    const container = await createContainer(AppModule, {
      overrides: [provide(AppConfig, { useValue: { port: 1, secret: 'test secret' } })],
    })

    expect(String(failure)).toContain('Invalid configuration "app":\n  SECRET: Expected at least 8 characters')
    expect(container.get(Server).config).toEqual({ port: 1, secret: 'test secret' })
  })
})
