/**
 * @module
 * WebSocket gateways, as in `@nestjs/websockets`.
 */

export { data, socket } from './arguments.ts'
export { SubscribeMessage, WebSocketGateway } from './decorators.ts'
export type { SubscribedMessage, SubscribeMessageDecorator, SubscribeMessageFactory } from './decorators.ts'
export type { GatewaySocket, GatewaySocketData, OnGatewayConnection, OnGatewayDisconnect } from './gateway.ts'
