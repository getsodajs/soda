import { afterAll, describe, expect, it } from 'bun:test'
import { createApp } from '../app/app.ts'
import type { App } from '../app/app.ts'
import { Module } from '../di/index.ts'
import { Logger } from '../logger/index.ts'
import type { LogEntry } from '../logger/index.ts'
import { pathOf } from '../utils/url.ts'
import { Controller, Get, HttpException, Post, requestLog } from './index.ts'

class MemoryLogger extends Logger {
  readonly entries: LogEntry[] = []

  write(entry: LogEntry): void {
    this.entries.push(entry)
  }
}

@Controller('/items')
class ItemsController {
  @Get()
  list(): string[] {
    return ['a']
  }

  @Post()
  create(): never {
    throw new HttpException('Invalid', 422)
  }

  @Get('/crash')
  crash(): never {
    throw new Error('boom')
  }
}

@Module({ controllers: [ItemsController] })
class ItemsModule {}

const apps: App[] = []

afterAll(async () => {
  for (const app of apps) {
    await app.close()
  }
})

const start = async (middleware = [requestLog()]) => {
  const logger = new MemoryLogger()
  const app = await createApp(ItemsModule, { logger, middleware })
  const server = await app.listen(0)

  apps.push(app)
  logger.entries.length = 0

  return { logger, request: (path: string, init: RequestInit = {}) => fetch(server.url.origin + path, init) }
}

describe('requestLog', () => {
  it('writes one entry per request, its level following the status, without the query', async () => {
    const { logger, request } = await start()

    await request('/items?token=secret')
    await request('/items', { method: 'POST' })
    await request('/missing')
    await request('/items/crash')

    const http = logger.entries.filter((entry) => entry.context === 'HTTP')

    expect(http.map(({ level, message, data }) => ({ level, message, status: data?.status }))).toEqual([
      { level: 'log', message: 'GET /items', status: 200 },
      { level: 'warn', message: 'POST /items', status: 422 },
      { level: 'warn', message: 'GET /missing', status: 404 },
      { level: 'error', message: 'GET /items/crash', status: 500 },
    ])
    expect(http[0]!.data?.ms).toBeNumber()
  })

  it('writes the status of an exception thrown by inner middleware', async () => {
    const { logger, request } = await start([
      requestLog(),
      () => {
        throw new HttpException('Down', 503)
      },
    ])

    expect((await request('/items')).status).toBe(503)
    expect(logger.entries.find((entry) => entry.context === 'HTTP')).toMatchObject({ level: 'error', message: 'GET /items', data: { status: 503 } })
  })

  it('serves several applications, each writing to its own logger', async () => {
    const shared = requestLog()
    const first = await start([shared])
    const second = await start([shared])

    await first.request('/items')
    await second.request('/items')
    await second.request('/items')

    expect(first.logger.entries.filter((entry) => entry.context === 'HTTP')).toHaveLength(1)
    expect(second.logger.entries.filter((entry) => entry.context === 'HTTP')).toHaveLength(2)
  })

  it('is listed as requestLog', () => {
    expect(requestLog().name).toBe('requestLog')
  })
})

describe('pathOf', () => {
  it('gives the path of a URL, without its query', () => {
    expect(pathOf('http://localhost:3000/users/7?full=1')).toBe('/users/7')
    expect(pathOf('http://localhost:3000/')).toBe('/')
    expect(pathOf('http://localhost:3000')).toBe('/')
  })
})
