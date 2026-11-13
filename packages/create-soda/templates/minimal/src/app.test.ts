import { afterAll, expect, test } from 'bun:test'
import { createTestApp } from '@getsoda/core/testing'
import { AppModule } from './app.module.ts'

const app = await createTestApp(AppModule)

afterAll(() => app.close())

test('GET / says hello', async () => {
  const response = await app.request('/')

  expect(response.status).toBe(200)
  expect(await response.text()).toBe('Hello Soda!')
})
