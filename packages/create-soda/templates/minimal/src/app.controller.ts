import { Controller, Get, inject } from '@getsoda/core'
import { AppService } from './app.service.ts'

@Controller()
export class AppController {
  readonly #app = inject(AppService)

  @Get()
  getHello(): string {
    return this.#app.getHello()
  }
}
