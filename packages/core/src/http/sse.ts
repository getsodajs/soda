/**
 * @module
 * Server-sent events: a route decorated with `@Sse()` returns an async
 * iterable of messages, streamed as `text/event-stream`, as Nest's `@Sse()`
 * streams an observable.
 *
 * ```ts
 * @Sse('ticks')
 * async *ticks(): AsyncGenerator<SseMessage> {
 *   for (let i = 0; ; i++) {
 *     yield { data: { tick: i } }
 *     await Bun.sleep(1000)
 *   }
 * }
 * ```
 *
 * When the client disconnects, the iterator is returned: a generator runs its
 * `finally` blocks. An error thrown while streaming ends the stream and is logged.
 */

import type { Context } from './context.ts'

/** One event. Fields are those of the `EventSource` protocol. */
export interface SseMessage {
  /** A string is sent as is, anything else as JSON. */
  readonly data: unknown
  /** Event name, listened to with `source.addEventListener(event, ...)`. */
  readonly event?: string
  /** Sent back by the browser as `Last-Event-ID` when it reconnects. */
  readonly id?: string
  /** Milliseconds the browser waits before reconnecting. */
  readonly retry?: number
}

/** Headers of Nest's SSE responses: no caching, no buffering by nginx. */
const SSE_HEADERS: readonly [string, string][] = [
  ['content-type', 'text/event-stream'],
  ['cache-control', 'private, no-cache, no-store, must-revalidate, max-age=0, no-transform'],
  ['x-accel-buffering', 'no'],
]

const NEWLINE = /\r\n|\r|\n/
const encoder = new TextEncoder()

const assertSingleLine = (name: string, value: string): void => {
  if (NEWLINE.test(value)) {
    throw new TypeError(`SSE ${name} must not contain line breaks: ${JSON.stringify(value)}`)
  }
}

/** A message in the event stream format, one `data:` line per line of data. */
export const formatSseMessage = (message: SseMessage): string => {
  const data = typeof message.data === 'string' ? message.data : JSON.stringify(message.data)
  let text = ''

  if (message.event !== undefined) {
    assertSingleLine('event', message.event)
    text += `event: ${message.event}\n`
  }

  if (message.id !== undefined) {
    assertSingleLine('id', message.id)
    text += `id: ${message.id}\n`
  }

  if (message.retry !== undefined) {
    text += `retry: ${Math.trunc(message.retry)}\n`
  }

  for (const line of (data ?? '').split(NEWLINE)) {
    text += `data: ${line}\n`
  }

  return `${text}\n`
}

const isAsyncIterable = (value: unknown): value is AsyncIterable<SseMessage> =>
  typeof value === 'object' && value !== null && Symbol.asyncIterator in value

/**
 * Creates the function streaming what an `@Sse()` route returns. `headers`
 * come from `@Header()`; errors while streaming go to `onError`.
 */
export const createSseResponder = (
  headers: readonly [string, string][],
  onError: (error: unknown, req: Request) => void
): ((value: unknown, ctx: Context) => Response) => {
  const init: ResponseInit = { status: 200, headers: [...SSE_HEADERS, ...headers] }

  return (value, ctx) => {
    if (!isAsyncIterable(value)) {
      throw new TypeError(`${ctx.route.controller.name}.${ctx.route.handler} is an @Sse() route: it must return an async iterable`)
    }

    const iterator = value[Symbol.asyncIterator]()

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next()

          if (next.done === true) {
            controller.close()
          } else {
            controller.enqueue(encoder.encode(formatSseMessage(next.value)))
          }
        } catch (error) {
          onError(error, ctx.req)
          controller.close()
        }
      },
      // The client went away: let the source clean up.
      async cancel() {
        await iterator.return?.()
      },
    })

    return new Response(body, init)
  }
}
