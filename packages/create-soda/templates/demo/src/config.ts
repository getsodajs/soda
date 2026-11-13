import { defineConfig } from '@getsoda/core'
import { z } from 'zod'

/** Read from the environment and checked at startup: an invalid value stops the application. */
export const AppConfig = defineConfig(
  'app',
  z.object({
    PORT: z.coerce.number().int().default(3000),
    CORS_ORIGIN: z.string().default('*'),
    JWT_SECRET: z.string().min(32, 'must be at least 32 characters: openssl rand -base64 32'),
  })
)
