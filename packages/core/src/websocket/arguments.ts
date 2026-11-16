/**
 * @module
 * Arguments of `@SubscribeMessage()` handlers, besides those of the handshake
 * request (`query()`, `header()`, `cookie()`, `value()`, `context()`).
 *
 * ```ts
 * @SubscribeMessage('say', [data(Message), socket(), value(USER)])
 * say(message: Message, socket: GatewaySocket, user: User) {}
 *
 * // Nest:
 * // @SubscribeMessage('say')
 * // say(@MessageBody() message: MessageDto, @ConnectedSocket() socket: WebSocket) {}
 * ```
 */

import type { Argument } from '../http/arguments.ts'
import type { InferOutput, StandardSchemaV1 } from '../http/schema.ts'
import type { GatewaySocket } from './gateway.ts'

const gatewayOnly = (name: string) => (): never => {
  throw new TypeError(`${name}() is read by gateways only`)
}

/**
 * The `data` of the message, validated by `schema`: an invalid one is answered
 * with an `exception` event, status `400`. Like `@MessageBody()` with a validation pipe.
 */
export function data(): Argument<unknown, 'message'>
export function data<S extends StandardSchemaV1>(schema: S): Argument<InferOutput<S>, 'message'>
export function data(schema?: StandardSchemaV1): Argument<unknown, 'message'> {
  return { kind: 'message', name: '', source: schema, read: gatewayOnly('data') }
}

/** The connection the message came from. Like `@ConnectedSocket()`. */
export const socket = (): Argument<GatewaySocket, 'socket'> => ({ kind: 'socket', name: '', read: gatewayOnly('socket') })
