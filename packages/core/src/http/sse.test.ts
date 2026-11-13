import { afterAll, describe, expect, it } from 'bun:test'
import { createContainer, Module } from '../di/index.ts'
import { compileRoutes } from '../routing/index.ts'
import { Controller, Sse } from './decorators.ts'
import { UseGuards } from './enhancers.ts'
import { controllerRoutes } from './routes.ts'
import { formatSseMessage } from './sse.ts'
import type { SseMessage } from './sse.ts'

const errors: unknown[] = []
let cleanedUp = Promise.withResolvers<void>()

@Controller('events')
class EventsController {
  @Sse('finite')
  async *finite(): AsyncGenerator<SseMessage> {
    yield { data: 'plain' }
    yield { data: { n: 1 }, event: 'update', id: '7', retry: 1500 }
    yield { data: 'two\nlines' }
  }

  @Sse('endless')
  async *endless(): AsyncGenerator<SseMessage> {
    try {
      for (let i = 0; ; i++) {
        yield { data: String(i) }
        await Bun.sleep(5)
      }
    } finally {
      cleanedUp.resolve()
    }
  }

  @Sse('failing')
  async *failing(): AsyncGenerator<SseMessage> {
    yield { data: 'before' }

    throw new Error('source failed')
  }

  @Sse('not-iterable')
  notIterable(): unknown {
    return { data: 'x' }
  }

  @Sse('guarded')
  @UseGuards(() => false)
  async *guarded(): AsyncGenerator<SseMessage> {
    yield { data: 'secret' }
  }
}

@Module({ controllers: [EventsController] })
class AppModule {}

const routes = controllerRoutes(await createContainer(AppModule), { onError: (error) => errors.push(error) })
const server = Bun.serve({ port: 0, ...compileRoutes(routes) })

afterAll(() => server.stop(true))

const open = (path: string, init?: RequestInit) => fetch(new URL(`/events/${path}`, server.url), init)

describe('@Sse()', () => {
  it('streams messages in the event stream format, with Nest headers', async () => {
    const response = await open('finite')

    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(response.headers.get('cache-control')).toContain('no-cache')
    expect(response.headers.get('x-accel-buffering')).toBe('no')
    expect(await response.text()).toBe(
      'data: plain\n\nevent: update\nid: 7\nretry: 1500\ndata: {"n":1}\n\ndata: two\ndata: lines\n\n'
    )
  })

  it('returns the iterator when the client disconnects', async () => {
    cleanedUp = Promise.withResolvers<void>()

    const controller = new AbortController()
    const response = await open('endless', { signal: controller.signal })
    const reader = response.body!.getReader()

    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: 0\n\n')
    controller.abort()
    await cleanedUp.promise
  })

  it('ends the stream and reports an error thrown while streaming', async () => {
    errors.length = 0

    expect(await (await open('failing')).text()).toBe('data: before\n\n')
    expect((errors[0] as Error).message).toBe('source failed')
  })

  it('answers 500 for a method that does not return an async iterable, and runs guards first', async () => {
    errors.length = 0

    expect((await open('not-iterable')).status).toBe(500)
    expect((errors[0] as Error).message).toBe('EventsController.notIterable is an @Sse() route: it must return an async iterable')
    expect((await open('guarded')).status).toBe(403)
  })

  it('refuses event names and ids spanning lines', () => {
    expect(() => formatSseMessage({ data: '', event: 'a\nb' })).toThrow('SSE event must not contain line breaks: "a\\nb"')
    expect(() => formatSseMessage({ data: '', id: '1\r2' })).toThrow('SSE id must not contain line breaks')
  })
})
