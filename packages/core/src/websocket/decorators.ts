/**
 * @module
 * Decorators of WebSocket gateways, as in `@nestjs/websockets`.
 */

import type { Constructor } from '../di/index.ts'
import type { Argument } from '../http/arguments.ts'
import type { ArgumentsRouteDecorator } from '../http/decorators.ts'
import { ControllerError } from '../http/errors.ts'

/** A `@SubscribeMessage()` declaration. */
export interface SubscribedMessage {
  readonly event: string
  /** Declared arguments; `undefined` when the method receives `(data, socket)`. */
  readonly args: readonly Argument<unknown>[] | undefined
}

const gateways = new WeakMap<Constructor<unknown>, string>()
const events = new WeakMap<object, SubscribedMessage>()

/**
 * Declares a gateway: WebSocket connections upgraded from `GET path`. List it
 * in the `controllers` of its module: like a controller, it is an entry point
 * the framework creates. The guards of the class run on the handshake, those
 * of a method on each of its messages.
 *
 * ```ts
 * @WebSocketGateway('/chat')
 * @UseGuards(JwtGuard)
 * class ChatGateway {
 *   @SubscribeMessage('say', [data(Message), socket()])
 *   say(message: Message, socket: GatewaySocket) {
 *     socket.publish('room', JSON.stringify({ event: 'said', data: message }))
 *   }
 * }
 * ```
 */
export const WebSocketGateway =
  (path: string) =>
  (target: Constructor<unknown>, _context: ClassDecoratorContext<Constructor<unknown>>): void => {
    if (!path.startsWith('/') || /[:*?]/.test(path)) {
      throw new ControllerError('INVALID_PATH', `@WebSocketGateway('${path}'): a gateway path is static and starts with "/"`)
    }

    gateways.set(target, path)
  }

/** Decorator of a handler without argument list: the method receives `(data, socket)`. */
export type SubscribeMessageDecorator = <This, M extends (this: This, ...args: any[]) => unknown>(
  method: M,
  context: ClassMethodDecoratorContext<This, M>
) => void

/**
 * `@SubscribeMessage(event)`, with an optional argument list as on routes.
 *
 * ```ts
 * @SubscribeMessage('echo')                            // echo(data: unknown, socket: GatewaySocket)
 * @SubscribeMessage('say', [data(Message), socket()])  // say(message: Message, socket: GatewaySocket)
 * ```
 */
export interface SubscribeMessageFactory {
  (event: string): SubscribeMessageDecorator
  <const A extends readonly Argument<unknown>[]>(event: string, args: A): ArgumentsRouteDecorator<A, '/'>
}

/**
 * Handles the frames `{ "event": event, "data": ... }` of a gateway. What the
 * method returns, unless `undefined`, is sent back as JSON; an error is sent as
 * an `exception` event.
 */
export const SubscribeMessage = ((event: string, args?: readonly Argument<unknown>[]) =>
  (method: object, context: ClassMethodDecoratorContext): void => {
    if (context.static || context.private) {
      throw new ControllerError('INVALID_HANDLER', `@SubscribeMessage('${event}') must decorate a public instance method`)
    }

    events.set(method, { event, args })
  }) as SubscribeMessageFactory

export const getGatewayPath = (target: Constructor<unknown>): string | undefined => gateways.get(target)

export const getSubscribedMessage = (method: object): SubscribedMessage | undefined => events.get(method)
