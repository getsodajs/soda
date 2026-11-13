import 'reflect-metadata'
import { Body, Controller, Get, Header, HttpCode, Module, Param, Post, Query } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { ExpressAdapter } from '@nestjs/platform-express'
import { FastifyAdapter } from '@nestjs/platform-fastify'

@Controller()
class BenchController {
  @Get()
  hi(): string {
    return 'Hi'
  }

  @Get('id/:id')
  @Header('x-powered-by', 'benchmark')
  id(@Param('id') id: string, @Query('name') name: string): string {
    return `${id} ${name}`
  }

  @Post('json')
  @HttpCode(200)
  json(@Body() value: unknown): unknown {
    return value
  }
}

@Module({ controllers: [BenchController] })
class AppModule {}

const adapter = process.env.ADAPTER === 'fastify' ? new FastifyAdapter() : new ExpressAdapter()
const app = await NestFactory.create(AppModule, adapter, { logger: false })

await app.listen(Number(process.env.PORT), '127.0.0.1')
