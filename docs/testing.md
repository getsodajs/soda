# Testing

Tests run with `bun test`. `@getsoda/core/testing` serves the application on a free port of localhost, with a silent logger, as Nest's `Test.createTestingModule()` with supertest does, on a real server.

```ts
import { afterAll, expect, test } from 'bun:test'
import { provide } from '@getsoda/core'
import { createTestApp } from '@getsoda/core/testing'
import { AppModule } from './app.module.ts'
import { Mailer } from './mail/mailer.ts'

const sent: string[] = []

const app = await createTestApp(AppModule, {
  overrides: [provide(Mailer, { useValue: { send: async (to: string) => void sent.push(to) } })],
})

afterAll(() => app.close())

test('signing up sends a welcome mail', async () => {
  const response = await app.request('/users', { method: 'POST', json: { name: 'Bo', email: 'bo@example.com' } })

  expect(response.status).toBe(201)
  expect(sent).toEqual(['bo@example.com'])
})
```

| Member | |
|---|---|
| `app.request(path, init?)` | `fetch()` relative to the application; `json` sends a JSON body |
| `app.get(token)` | a provider, as the root module sees it |
| `app.url` | where it listens |
| `app.app` | the application itself |
| `app.close()` | closes it; `await using app = await createTestApp(...)` does it at the end of the block |

The second argument takes every option of `createApp()`: `prefix`, `guards`, `middleware`...

## Replacing providers

`overrides` replace providers of the same token everywhere in the graph, as Nest's `overrideProvider()`. An override that replaces nothing is an error: a renamed provider cannot leave a test silently using the real one.

```ts
overrides: [
  provide(UsersRepository, { useClass: MemoryUsersRepository }),
  provide(AppConfig, { useValue: { PORT: 0, JWT_SECRET: 'x'.repeat(32) } }), // not loaded from the environment
]
```

## Signed-in requests

```ts
const login = await app.request('/auth/login', { method: 'POST', json: { email, password } })
const { token } = (await login.json()) as { token: string }

const me = await app.request('/auth/me', { headers: { authorization: `Bearer ${token}` } })
```

Or sign a token directly: `await app.get(JwtService).sign({ sub: '1' })`.

## WebSockets

```ts
const socket = new WebSocket(new URL('/chat', app.url.href.replace('http', 'ws')))
const message = new Promise((resolve) => socket.addEventListener('message', (event) => resolve(JSON.parse(String(event.data)))))

await new Promise((resolve) => socket.addEventListener('open', resolve))
socket.send(JSON.stringify({ event: 'say', data: { text: 'hi' } }))

expect(await message).toEqual({ event: 'sent', data: null })
```

## Services alone

A service needs no server: build its module with `createContainer()`.

```ts
import { createContainer, provide } from '@getsoda/core'

const container = await createContainer(UsersModule, { overrides: [provide(UsersRepository, { useClass: MemoryUsersRepository })] })
const users = container.get(UsersService)

expect(users.create('Ann').id).toBe(1)
await container.close()
```

## Time

`setSystemTime()` from `bun:test` moves `Date.now()`: expiring tokens, rate limit windows and the like are tested without waiting.
