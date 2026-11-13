import { cors, createApp } from '@getsoda/core'
import { AppModule } from './app.module.ts'

const app = await createApp(AppModule, {
  middleware: [cors({ origin: process.env.CORS_ORIGIN ?? '*' })],
})

app.enableShutdownSignals()
await app.listen(Number(process.env.PORT ?? 3000))
