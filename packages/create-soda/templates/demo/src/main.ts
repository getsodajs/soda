import { cors, createApp } from '@getsoda/core'
import { AppModule } from './app.module.ts'
import { AppConfig } from './config.ts'

// Loaded first for what the application needs before it exists; services inject it.
const config = await AppConfig.load()
const app = await createApp(AppModule, { middleware: [cors({ origin: config.CORS_ORIGIN })] })

app.enableShutdownSignals()
await app.listen(config.PORT)
