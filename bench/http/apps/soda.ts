import { body, Controller, createApp, Get, Header, HttpCode, Module, param, Post, query } from '@getsoda/core'

@Controller()
class BenchController {
  @Get()
  hi(): string {
    return 'Hi'
  }

  @Get('id/:id', [param('id'), query('name')])
  @Header('x-powered-by', 'benchmark')
  id(id: string, name: string | undefined): string {
    return `${id} ${name}`
  }

  @Post('json', [body()])
  @HttpCode(200)
  json(value: unknown): unknown {
    return value
  }
}

@Module({ controllers: [BenchController] })
class AppModule {}

const app = await createApp(AppModule, { logger: false })

await app.listen(Number(process.env.PORT))
