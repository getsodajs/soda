# Rate limiting

`@getsoda/core/throttler` limits how many requests each client sends to each route, as `@nestjs/throttler` does.

```ts
import { ThrottlerGuard, ThrottlerModule } from '@getsoda/core/throttler'

@Module({ imports: [ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 100 }] })] })
export class AppModule {}

const app = await createApp(AppModule, { guards: [ThrottlerGuard] })
```

Every client may now send 100 requests a minute to each route. Past that, it gets `429 Too Many Requests` with `Retry-After` in seconds, until the window ends.

`ThrottlerModule` is global. `ThrottlerGuard` may also protect a few controllers with `@UseGuards(ThrottlerGuard)` instead of all of them.

## Several limits

Every limit applies; name them to change them apart:

```ts
ThrottlerModule.forRoot({
  throttlers: [
    { name: 'burst', ttl: 1000, limit: 5 },  // 5 per second
    { ttl: 60_000, limit: 100 },             // and 100 per minute, named `default`
  ],
})
```

`blockDuration` (milliseconds) refuses a client past the limit for that long instead of the rest of the window: `{ ttl: 60_000, limit: 5, blockDuration: 15 * 60_000 }`.

## Per route

```ts
@Post('login')
@Throttle({ default: { limit: 5, ttl: 60_000 } }) // stricter for logins
login() {}

@Controller('health')
@SkipThrottle()                                    // not counted at all
export class HealthController {}

@Get('report')
@SkipThrottle({ burst: true })                     // only the `default` limit applies
report() {}
```

On a method, they win over the class: `@SkipThrottle({ default: false })` counts a route of a skipped controller.

Each route is counted apart: `login` and `register` each have their own 5 a minute.

## Headers

Successful responses tell clients where they are:

| Header | |
|---|---|
| `X-RateLimit-Limit` | requests allowed per window |
| `X-RateLimit-Remaining` | requests left in this window |
| `X-RateLimit-Reset` | seconds until the window ends |
| `Retry-After` | on a `429`: seconds until the client is let in again |

For a limit named `burst`, the headers are `X-RateLimit-Limit-burst` and so on. `headers: false` sends none but `Retry-After`.

## Who is a client

By default, `ctx.ip`: the address of the peer. Behind a reverse proxy or a load balancer that is the proxy, and every client would share one limit. Read the client from the header the proxy sets:

```ts
ThrottlerModule.forRoot({
  throttlers: [{ ttl: 60_000, limit: 100 }],
  // The last address is the one your proxy appended: clients can write the ones before it.
  tracker: (ctx) => ctx.header('x-forwarded-for')?.split(',').at(-1)?.trim() ?? ctx.ip,
})
```

Trust that header only behind a proxy that sets it. A tracker may also count users instead of addresses: `(ctx) => ctx.has(USER) ? ctx.get(USER).id : ctx.ip`, with the guard that sets `USER` before `ThrottlerGuard`. A tracker returning `undefined` lets the request through uncounted.

`skip: (ctx) => boolean` lets requests through uncounted, such as those of your own monitoring.

## Configuration from providers

```ts
ThrottlerModule.forRootAsync({
  inject: [AppConfig],
  useFactory: (config) => ({ throttlers: [{ ttl: 60_000, limit: config.RATE_LIMIT }] }),
})
```

## Several instances

Counts live in the memory of the process: right for one instance. With several (behind a load balancer, in a cluster), each counts on its own, so a client may send the limit to each. Share the counts with a `ThrottlerStorage`, such as one on Redis:

```ts
import { RedisClient } from 'bun'
import type { ThrottlerRecord, ThrottlerStorage } from '@getsoda/core/throttler'

export class RedisThrottlerStorage implements ThrottlerStorage {
  readonly #redis = new RedisClient(process.env.REDIS_URL)

  async increment(key: string, ttl: number, limit: number, blockDuration: number): Promise<ThrottlerRecord> {
    const blocked = Number(await this.#redis.send('PTTL', [`${key}:blocked`]))

    if (blocked > 0) {
      return { totalHits: limit + 1, timeToExpire: blocked, isBlocked: true, timeToBlockExpire: blocked }
    }

    const hits = Number(await this.#redis.send('INCR', [key]))

    if (hits === 1) {
      await this.#redis.send('PEXPIRE', [key, String(ttl)])
    }

    const timeToExpire = Math.max(0, Number(await this.#redis.send('PTTL', [key])))

    if (hits > limit) {
      await this.#redis.send('SET', [`${key}:blocked`, '1', 'PX', String(blockDuration)])

      return { totalHits: hits, timeToExpire, isBlocked: true, timeToBlockExpire: blockDuration }
    }

    return { totalHits: hits, timeToExpire, isBlocked: false, timeToBlockExpire: 0 }
  }
}

ThrottlerModule.forRoot({ throttlers, storage: new RedisThrottlerStorage() })
```

The memory storage drops expired keys every minute, so its memory follows the clients that are active, not every client ever seen.

## WebSockets

On a gateway, `ThrottlerGuard` among the class guards limits handshakes: how often a client may connect.
