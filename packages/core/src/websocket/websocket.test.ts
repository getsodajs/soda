import { afterAll, describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { createApp } from '../app/app.ts'
import { Module } from '../di/index.ts'
import { body, query, value } from '../http/arguments.ts'
import type { Context } from '../http/context.ts'
import { ContextKey } from '../http/context-key.ts'
import { Controller, Get } from '../http/decorators.ts'
import { UseGuards, UseInterceptors } from '../http/enhancers.ts'
import { ControllerError } from '../http/errors.ts'
import { Logger } from '../logger/index.ts'
import type { LogEntry } from '../logger/index.ts'
import { createTestApp } from '../testing/index.ts'
import { data, socket } from './arguments.ts'
import { SubscribeMessage, WebSocketGateway } from './decorators.ts'
import type { GatewaySocket, OnGatewayConnection, OnGatewayDisconnect } from './gateway.ts'

const USER = new ContextKey<string>('user')

/** Lets in `?user=name`, as a guard reading a token would. */
const authenticate = (ctx: Context): boolean => {
  const user = ctx.query('user')

  if (user !== undefined) {
    ctx.set(USER, user)
  }

  return user !== undefined
}

/** Lets in messages of `ann` only, as a role check would. */
const annOnly = (ctx: Context): boolean => ctx.get(USER) === 'ann'

const Say = z.object({ text: z.string().min(1) })

const events: string[] = []

@WebSocketGateway('/chat')
@UseGuards(authenticate)
class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  handleConnection(socket: GatewaySocket): void {
    events.push(`connected ${socket.data.context.get(USER)}`)
    socket.subscribe('room')
  }

  handleDisconnect(socket: GatewaySocket, code: number): void {
    events.push(`disconnected ${socket.data.context.get(USER)} ${code}`)
  }

  @SubscribeMessage('echo')
  echo(data: unknown, socket: GatewaySocket): unknown {
    return { event: 'echo', data, user: socket.data.context.get(USER) }
  }

  @SubscribeMessage('say')
  say(data: unknown, socket: GatewaySocket): void {
    socket.publish('room', JSON.stringify({ event: 'said', data }))
  }

  @SubscribeMessage('fail')
  async fail(): Promise<never> {
    throw new Error('handler failed')
  }

  @SubscribeMessage('post', [data(Say), value(USER), query('room'), socket()])
  post(message: z.infer<typeof Say>, user: string, room: string | undefined, client: GatewaySocket): unknown {
    return { event: 'posted', data: { text: message.text, user, room, open: client.readyState === 1 } }
  }

  @SubscribeMessage('admin')
  @UseGuards(annOnly)
  admin(): unknown {
    return { event: 'admin', data: 'granted' }
  }
}

@Module({ controllers: [ChatGateway] })
class AppModule {}

class MemoryLogger extends Logger {
  readonly entries: LogEntry[] = []

  write(entry: LogEntry): void {
    this.entries.push(entry)
  }
}

const logger = new MemoryLogger()
const app = await createTestApp(AppModule, { logger })

afterAll(() => app.close())

/** An open socket and the messages it receives, parsed. */
const connect = async (user: string) => {
  const socket = new WebSocket(new URL(`/chat?user=${user}&room=lobby`, app.url.href.replace('http', 'ws')))
  const received: unknown[] = []
  const waiting: ((value: unknown) => void)[] = []

  socket.addEventListener('message', (event) => {
    const value = JSON.parse(String(event.data)) as unknown
    const waiter = waiting.shift()

    if (waiter === undefined) {
      received.push(value)
    } else {
      waiter(value)
    }
  })
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve)
    socket.addEventListener('error', reject)
  })

  const next = (): Promise<unknown> =>
    received.length > 0 ? Promise.resolve(received.shift()) : new Promise((resolve) => waiting.push(resolve))
  const closed = new Promise<number>((resolve) => socket.addEventListener('close', (event) => resolve(event.code)))

  return { socket, next, closed, send: (frame: unknown) => socket.send(typeof frame === 'string' ? frame : JSON.stringify(frame)) }
}

describe('WebSocket gateways', () => {
  it('replies to subscribed events with what the handler returns, values of the handshake included', async () => {
    const ann = await connect('ann')

    ann.send({ event: 'echo', data: { n: 1 } })

    expect(await ann.next()).toEqual({ event: 'echo', data: { n: 1 }, user: 'ann' })
    ann.socket.close(1000)
    expect(await ann.closed).toBe(1000)
  })

  it('drops frames that are not JSON events, or name no handled event', async () => {
    const bo = await connect('bo')

    bo.send('not json')
    bo.send({ data: 'no event' })
    bo.send({ event: 'unknown', data: 1 })
    bo.send('{"__proto__":{"polluted":true},"event":"echo"}')
    bo.socket.send(new Uint8Array([1, 2, 3]))
    bo.send({ event: 'echo', data: 'after' })

    expect(await bo.next()).toEqual({ event: 'echo', data: 'after', user: 'bo' })
    bo.socket.close()
  })

  it('answers handler errors with a bare exception event, reports them and keeps the connection', async () => {
    const cy = await connect('cy')

    cy.send({ event: 'fail' })
    cy.send({ event: 'echo', data: 'still open' })

    expect(await cy.next()).toEqual({ event: 'exception', data: { statusCode: 500, message: 'Internal server error', event: 'fail' } })
    expect(await cy.next()).toEqual({ event: 'echo', data: 'still open', user: 'cy' })
    expect(logger.entries.some((entry) => (entry.data?.error as Error | undefined)?.message === 'handler failed')).toBe(true)
    cy.socket.close()
  })

  it('gives the declared arguments: validated data, values and query of the handshake, the socket', async () => {
    const ann = await connect('ann')

    ann.send({ event: 'post', data: { text: 'hi' } })
    ann.send({ event: 'post', data: { text: '' } })

    expect(await ann.next()).toEqual({ event: 'posted', data: { text: 'hi', user: 'ann', room: 'lobby', open: true } })
    expect(await ann.next()).toEqual({
      event: 'exception',
      data: { statusCode: 400, message: [expect.stringContaining('text')], error: 'Bad Request', event: 'post' },
    })
    ann.socket.close()
  })

  it('runs the guards of a handler on each of its messages, with what the handshake set', async () => {
    const ann = await connect('ann')
    const bo = await connect('bo')

    ann.send({ event: 'admin' })
    bo.send({ event: 'admin' })

    expect(await ann.next()).toEqual({ event: 'admin', data: 'granted' })
    expect(await bo.next()).toEqual({
      event: 'exception',
      data: { statusCode: 403, message: 'Forbidden resource', error: 'Forbidden', event: 'admin' },
    })
    ann.socket.close()
    bo.socket.close()
  })

  it('lets sockets publish to the topics others subscribed to', async () => {
    const di = await connect('di')
    const ed = await connect('ed')

    di.send({ event: 'say', data: 'hello' })

    expect(await ed.next()).toEqual({ event: 'said', data: 'hello' })
    di.socket.close()
    ed.socket.close()
  })

  it('runs the guards of the gateway on the handshake', async () => {
    const refused = await fetch(new URL('/chat', app.url))
    const notUpgraded = await fetch(new URL('/chat?user=fay', app.url))

    expect(refused.status).toBe(403)
    expect(notUpgraded.status).toBe(426)
  })

  it('calls the connection hooks, and closes sockets with 1001 when the application closes', async () => {
    const other = await createTestApp(AppModule)
    const socket = new WebSocket(new URL('/chat?user=gus', other.url.href.replace('http', 'ws')))
    const closed = new Promise<number>((resolve) => socket.addEventListener('close', (event) => resolve(event.code)))

    events.length = 0
    await new Promise((resolve) => socket.addEventListener('open', resolve))
    await other.close()

    expect(await closed).toBe(1001)
    expect(events).toEqual(['connected gus', 'disconnected gus 1001'])
  })

  it('refuses a gateway on the path of a route, and paths that are not static', async () => {
    @Controller('/chat')
    class ChatController {
      @Get()
      read(): string {
        return 'chat'
      }
    }

    @Module({ controllers: [ChatController, ChatGateway] })
    class ClashModule {}

    const error = await createApp(ClashModule, { logger: false }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ControllerError)
    expect((error as ControllerError).code).toBe('DUPLICATE_ROUTE')
    expect(() => WebSocketGateway('/rooms/:id')(class {}, {} as ClassDecoratorContext<new () => unknown>)).toThrow(
      `@WebSocketGateway('/rooms/:id'): a gateway path is static and starts with "/"`
    )
  })

  it('refuses at startup the arguments and enhancers a message cannot have', async () => {
    const refusal = async (gateway: new () => unknown): Promise<string> => {
      @Module({ controllers: [gateway] })
      class BrokenModule {}

      const error = (await createApp(BrokenModule, { logger: false }).catch((caught: unknown) => caught)) as ControllerError

      return `${error.code}: ${error.message}`
    }

    @WebSocketGateway('/a')
    class BodyGateway {
      @SubscribeMessage('x', [body()])
      x(_body: unknown): void {}
    }

    @WebSocketGateway('/b')
    class InterceptedGateway {
      @SubscribeMessage('x')
      @UseInterceptors((_ctx, next) => next())
      x(): void {}
    }

    @WebSocketGateway('/c')
    class TwiceGateway {
      @SubscribeMessage('x')
      first(): void {}

      @SubscribeMessage('x')
      second(): void {}
    }

    @Controller('/d')
    class DataController {
      @Get([data()])
      read(_data: unknown): void {}
    }

    expect(await refusal(BodyGateway)).toBe('INVALID_ARGUMENT: BodyGateway.x: a message has no request body, read it with data()')
    expect(await refusal(InterceptedGateway)).toBe(
      'INVALID_HANDLER: InterceptedGateway.x: message handlers take guards, not interceptors or exception filters'
    )
    expect(await refusal(TwiceGateway)).toBe('DUPLICATE_ROUTE: TwiceGateway.second: another method of TwiceGateway handles "x"')
    expect(await refusal(DataController)).toBe('INVALID_ARGUMENT: DataController.read: data() is an argument of @SubscribeMessage(), not of a route')
  })

  // Checked by the type checker only, never called.
  const typeErrors = (): void => {
    @WebSocketGateway('/typed')
    class Typed {
      // @ts-expect-error the data is a { text: string }, not a number
      @SubscribeMessage('post', [data(Say)])
      post(_message: number): void {}
    }

    void Typed
  }

  void typeErrors
})
