# Configuration

A configuration is a schema over the environment, validated when the application starts and injected with its type. What `@nestjs/config` does with `registerAs()` and a validation schema, without string keys.

```ts
// src/config.ts
import { defineConfig } from '@getsoda/core'
import { z } from 'zod'

export const AppConfig = defineConfig(
  'app',
  z.object({
    PORT: z.coerce.number().int().default(3000),
    CORS_ORIGIN: z.string().default('http://localhost:5173'),
    JWT_SECRET: z.string().min(32),
  })
)
```

```ts
@Module({ imports: [ConfigModule.forRoot({ load: [AppConfig], global: true })] })
export class AppModule {}

export class AuthService {
  readonly #config = inject(AppConfig) // { PORT: number; CORS_ORIGIN: string; JWT_SECRET: string }
}
```

Bun loads `.env`, `.env.local` and `.env.<NODE_ENV>` into `process.env` by itself; no `dotenv` is needed.

## Invalid environments

A configuration that does not match its schema stops the startup, with every issue at once:

```
ConfigError: Invalid configuration "app":
  JWT_SECRET: Invalid input: expected string, received undefined
```

## Before the application exists

`main.ts` may need values before `createApp()`: the port, the CORS origin. `load()` reads a configuration without the container:

```ts
const config = await AppConfig.load()
const app = await createApp(AppModule, { middleware: [cors({ origin: config.CORS_ORIGIN })] })

await app.listen(config.PORT)
```

## Nested configurations

The third argument builds the input of the schema from the environment:

```ts
export const DatabaseConfig = defineConfig(
  'database',
  z.object({
    url: z.url(),
    pool: z.object({ max: z.coerce.number().int().default(10) }),
  }),
  (env) => ({ url: env.DATABASE_URL, pool: { max: env.DATABASE_POOL_MAX } })
)
```

## Several configurations

Each is a token of its own: a module injects what it uses, tests replace one without the others.

```ts
ConfigModule.forRoot({ load: [AppConfig, DatabaseConfig, MailConfig], global: true })
```

`env` replaces `process.env` as the source: `ConfigModule.forRoot({ load, env: { PORT: '4000' } })`.

## In tests

```ts
await createTestApp(AppModule, {
  overrides: [provide(AppConfig, { useValue: { PORT: 0, CORS_ORIGIN: '*', JWT_SECRET: 'x'.repeat(32) } })],
})
```

A replaced configuration is not loaded, so tests need no environment for it.

## Secrets

Keep `.env` out of git and commit an `.env.example` listing every variable. Projects made with the `demo` template get a `.env` whose empty `*_SECRET=` lines are filled with random values.
