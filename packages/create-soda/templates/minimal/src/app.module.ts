import { Module } from '@getsoda/core'
import { AppController } from './app.controller.ts'
import { AppService } from './app.service.ts'

@Module({ providers: [AppService], controllers: [AppController] })
export class AppModule {}
