import { afterAll, afterEach, describe, expect, it, setSystemTime } from 'bun:test'
import { Module } from '../di/index.ts'
import { Controller, Get, Post } from '../http/decorators.ts'
import { createTestApp } from '../testing/index.ts'
import { SkipThrottle, Throttle, ThrottlerGuard } from './guard.ts'
import { ThrottlerModule } from './module.ts'
import { MemoryThrottlerStorage } from './storage.ts'

@Controller('/a')
class LimitedController {
  @Get('one')
  one(): string {
    return 'one'
  }

  @Get('two')
  two(): string {
    return 'two'
  }

  @Post('login')
  @Throttle({ default: { limit: 1 } })
  login(): string {
    return 'in'
  }
}

@Controller('/free')
@SkipThrottle()
class FreeController {
  @Get()
  free(): string {
    return 'free'
  }

  @Get('counted')
  @SkipThrottle({ default: false })
  counted(): string {
    return 'counted'
  }
}

@Module({
  imports: [ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 2 }] })],
  controllers: [LimitedController, FreeController],
})
class AppModule {}

const app = await createTestApp(AppModule, { guards: [ThrottlerGuard] })

afterAll(() => app.close())

const statuses = async (path: string, times: number, init?: RequestInit): Promise<number[]> => {
  const result: number[] = []

  for (let i = 0; i < times; i++) {
    result.push((await app.request(path, init)).status)
  }

  return result
}

describe('ThrottlerGuard', () => {
  it('lets in the limit, then answers 429 with Retry-After', async () => {
    const first = await app.request('/a/one')
    const second = await app.request('/a/one')
    const third = await app.request('/a/one')

    expect([first.status, second.status, third.status]).toEqual([200, 200, 429])
    expect(first.headers.get('x-ratelimit-limit')).toBe('2')
    expect(first.headers.get('x-ratelimit-remaining')).toBe('1')
    expect(second.headers.get('x-ratelimit-remaining')).toBe('0')
    expect(first.headers.get('x-ratelimit-reset')).toBe('60')
    expect(third.headers.get('retry-after')).toBe('60')
    expect(await third.json()).toEqual({ statusCode: 429, message: 'Too Many Requests', error: 'Too Many Requests' })
  })

  it('counts each route apart, and takes the limits of @Throttle()', async () => {
    expect(await statuses('/a/two', 3)).toEqual([200, 200, 429])
    expect(await statuses('/a/login', 2, { method: 'POST' })).toEqual([201, 429])
  })

  it('skips what @SkipThrottle() names, a method lifting the skip of its class', async () => {
    expect(await statuses('/free', 4)).toEqual([200, 200, 200, 200])
    expect(await statuses('/free/counted', 3)).toEqual([200, 200, 429])
  })
})

describe('ThrottlerModule options', () => {
  @Controller('/')
  class PingController {
    @Get()
    ping(): string {
      return 'pong'
    }
  }

  it('applies every named limit, tracks whom the tracker says, and skips what skip says', async () => {
    @Module({
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [
            { name: 'burst', ttl: 1000, limit: 1 },
            { ttl: 60_000, limit: 10 },
          ],
          tracker: (ctx) => ctx.header('x-client'),
          skip: (ctx) => ctx.header('x-internal') === 'yes',
        }),
      ],
      controllers: [PingController],
    })
    class NamedModule {}

    await using named = await createTestApp(NamedModule, { guards: [ThrottlerGuard] })

    const ann = { headers: { 'x-client': 'ann' } }
    const first = await named.request('/', ann)
    const second = await named.request('/', ann)

    expect(first.headers.get('x-ratelimit-limit-burst')).toBe('1')
    expect(first.headers.get('x-ratelimit-limit')).toBe('10')
    expect(second.status).toBe(429)
    expect(second.headers.get('retry-after-burst')).toBe('1')
    expect((await named.request('/', { headers: { 'x-client': 'bo' } })).status).toBe(200)
    expect((await named.request('/', { headers: { 'x-client': 'ann', 'x-internal': 'yes' } })).status).toBe(200)
    // No tracker value: not counted.
    expect(await Promise.all([named.request('/'), named.request('/')]).then((all) => all.map((r) => r.status))).toEqual([200, 200])
  })

  it('reads its options from a factory', async () => {
    @Module({
      imports: [ThrottlerModule.forRootAsync({ useFactory: async () => ({ throttlers: [{ ttl: 1000, limit: 1 }], headers: false }) })],
      controllers: [PingController],
    })
    class AsyncModule {}

    await using limited = await createTestApp(AsyncModule, { guards: [ThrottlerGuard] })

    const first = await limited.request('/')

    expect(first.headers.has('x-ratelimit-limit')).toBe(false)
    expect((await limited.request('/')).status).toBe(429)
  })
})

describe('MemoryThrottlerStorage', () => {
  afterEach(() => setSystemTime())

  it('counts in windows, blocks past the limit, and starts over when the block ends', () => {
    const storage = new MemoryThrottlerStorage()

    setSystemTime(new Date('2026-01-01T00:00:00Z'))
    expect(storage.increment('k', 1000, 1, 5000)).toEqual({ totalHits: 1, timeToExpire: 1000, isBlocked: false, timeToBlockExpire: 0 })
    expect(storage.increment('k', 1000, 1, 5000)).toEqual({ totalHits: 2, timeToExpire: 1000, isBlocked: true, timeToBlockExpire: 5000 })

    setSystemTime(new Date('2026-01-01T00:00:02Z'))
    expect(storage.increment('k', 1000, 1, 5000)).toMatchObject({ isBlocked: true, timeToExpire: 0, timeToBlockExpire: 3000 })

    setSystemTime(new Date('2026-01-01T00:00:05Z'))
    expect(storage.increment('k', 1000, 1, 5000)).toEqual({ totalHits: 1, timeToExpire: 1000, isBlocked: false, timeToBlockExpire: 0 })
    expect(storage.size).toBe(1)
    storage.onDestroy()
  })
})
