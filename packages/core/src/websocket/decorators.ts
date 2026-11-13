/**
 * @module
 * Decorators of WebSocket gateways, as in `@nestjs/websockets`.
 */

import type { Constructor } from '../di/index.ts'
import { ControllerError } from '../http/errors.ts'

const gateways = new WeakMap<Constructor<unknown>, string>()
const events = new WeakMap<object, string>()

/**
 * Declares a gateway: WebSocket connections upgraded from `GET path`. List it
 * in the `controllers` of its module: like a controller, it is an entry point
 * the framework creates, and its guards run on the handshake.
 *
 * ```ts
 * @WebSocketGateway('/chat')
 * @UseGuards(JwtGuard)
 * class ChatGateway {
 *   @SubscribeMessage('message')
 *   message(data: unknown, socket: GatewaySocket) {
 *     return { event: 'message', data }
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

/**
 * Handles the frames `{ "event": event, "data": ... }` of a gateway. The
 * method receives `(data, socket)`; what it returns, unless `undefined`, is
 * sent back as JSON.
 */
export const SubscribeMessage =
  (event: string) =>
  <This, M extends (this: This, ...args: any[]) => unknown>(method: M, context: ClassMethodDecoratorContext<This, M>): void => {
    if (context.static || context.private) {
      throw new ControllerError('INVALID_HANDLER', `@SubscribeMessage('${event}') must decorate a public instance method`)
    }

    events.set(method, event)
  }

export const getGatewayPath = (target: Constructor<unknown>): string | undefined => gateways.get(target)

export const getSubscribedEvent = (method: object): string | undefined => events.get(method)
