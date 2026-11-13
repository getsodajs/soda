import { afterAll, expect, test } from 'bun:test'
import { createApp } from '@getsoda/core'
import { AppModule } from './app.module.ts'

const app = await createApp(AppModule, { logger: false })
const server = await app.listen(0)

afterAll(() => app.close())

test('GET / says hello', async () => {
  const response = await fetch(server.url)

  expect(response.status).toBe(200)
  expect(await response.text()).toBe('Hello Soda!')
})
