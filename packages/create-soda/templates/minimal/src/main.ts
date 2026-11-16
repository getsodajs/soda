import { createApp, requestLog } from '@getsoda/core'
import { AppModule } from './app.module.ts'

const app = await createApp(AppModule, { middleware: [requestLog()] })

app.enableShutdownSignals()
await app.listen(Number(process.env.PORT ?? 3000))
