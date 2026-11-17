import { afterAll, describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { Module } from '../di/index.ts'
import { Logger } from '../logger/index.ts'
import type { LogEntry } from '../logger/index.ts'
import { createTestApp } from '../testing/index.ts'
import type { TestApp } from '../testing/index.ts'
import { Controller, ControllerError, Get, int, param, Post, Returns, Sse, UseInterceptors } from './index.ts'
import type { CallHandler, Context, SseMessage } from './index.ts'

class MemoryLogger extends Logger {
  readonly entries: LogEntry[] = []

  write(entry: LogEntry): void {
    this.entries.push(entry)
  }
}

const UserRow = z.object({ id: z.number(), name: z.string(), passwordHash: z.string() })
const User = UserRow.omit({ passwordHash: true })
const rows = [{ id: 1, name: 'Ada', passwordHash: 'secret' }]

const seen: unknown[] = []

const record = async (_ctx: Context, next: CallHandler): Promise<unknown> => {
  const value = await next()

  seen.push(value)

  return value
}

@Controller('users')
class UsersController {
  @Get(':id', [param('id', int)])
  @Returns(User)
  findOne(id: number) {
    return rows.find((row) => row.id === id)!
  }

  @Get()
  @Returns(z.array(User))
  async list() {
    return rows
  }

  @Get('wrong')
  @Returns(User)
  wrong() {
    return { id: 'one', name: 'Ada' } as unknown as z.input<typeof User>
  }

  @Get('raw')
  @Returns(User)
  raw() {
    return new Response('as is', { status: 202 })
  }

  @Post()
  @Returns(z.object({ id: z.number(), createdAt: z.date().transform((date) => date.toISOString()) }))
  @UseInterceptors(record)
  create() {
    return { id: 2, createdAt: new Date(0) }
  }
}

@Module({ controllers: [UsersController] })
class UsersModule {}

const logger = new MemoryLogger()
const app: TestApp = await createTestApp(UsersModule, { logger })

afterAll(() => app.close())

describe('@Returns', () => {
  it('sends what the schema keeps, leaving out the fields it does not declare', async () => {
    expect(await (await app.request('/users/1')).json()).toEqual({ id: 1, name: 'Ada' })
    expect(await (await app.request('/users')).json()).toEqual([{ id: 1, name: 'Ada' }])
  })

  it('sends the output of the schema, which interceptors see', async () => {
    const response = await app.request('/users', { method: 'POST' })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ id: 2, createdAt: '1970-01-01T00:00:00.000Z' })
    expect(seen).toEqual([{ id: 2, createdAt: '1970-01-01T00:00:00.000Z' }])
  })

  it('answers 500 for a value the schema refuses, the issues in the log only', async () => {
    const response = await app.request('/users/wrong')
    const text = await response.text()

    expect(response.status).toBe(500)
    expect(text).not.toContain('id')
    expect(String(logger.entries.find((entry) => entry.level === 'error')?.data?.error)).toContain(
      'UsersController.wrong returned a value its @Returns() schema refuses: id:'
    )
  })

  it('sends a returned Response as is', async () => {
    const response = await app.request('/users/raw')

    expect(response.status).toBe(202)
    expect(await response.text()).toBe('as is')
  })

  it('refuses what is not a schema, twice on one method, and on @Sse()', async () => {
    const declare = (decorate: () => void) => {
      try {
        decorate()
      } catch (error) {
        return error
      }
    }

    expect(
      declare(() => {
        class Twice {
          @Returns(User)
          @Returns(User)
          one() {
            return rows[0]!
          }
        }

        return Twice
      })
    ).toMatchObject({ code: 'INVALID_RETURNS', message: 'one has more than one @Returns()' })

    expect(
      declare(() => {
        class NotSchema {
          // @ts-expect-error A parser is not a schema.
          @Returns(int)
          one() {
            return 1
          }
        }

        return NotSchema
      })
    ).toBeInstanceOf(ControllerError)

    @Controller('events')
    class EventsController {
      @Sse()
      // @ts-expect-error An event stream is not what the schema accepts.
      @Returns(z.string())
      async *stream(): AsyncGenerator<SseMessage> {}
    }

    @Module({ controllers: [EventsController] })
    class EventsModule {}

    await expect(createTestApp(EventsModule)).rejects.toMatchObject({ code: 'INVALID_RETURNS' })
  })
})

// Checked by the type checker: each @ts-expect-error must stay an error.
export class Typed {
  // More fields than the schema: they are left out.
  @Returns(User)
  extra() {
    return rows[0]!
  }

  @Returns(User)
  async promised() {
    return rows[0]!
  }

  // @ts-expect-error `name` is missing.
  @Returns(User)
  missing() {
    return { id: 1 }
  }

  // @ts-expect-error `undefined` is not a user.
  @Returns(User)
  maybe() {
    return rows.find((row) => row.id === 2)
  }
}
