/**
 * @module
 * Serving a gateway: the handshake goes through the route pipeline (guards
 * and exception filters of the gateway), then frames are dispatched to its
 * `@SubscribeMessage()` methods, through the guards of each method.
 *
 * The protocol is the one of Nest's `WsAdapter`: text frames holding
 * `{ "event": string, "data": any }`. Frames that are not JSON, not such an
 * object, or name no handled event are dropped silently, as anyone can send
 * them. A handler that fails is answered with
 * `{ "event": "exception", "data": { statusCode, message, event } }`, like
 * Nest's `BaseWsExceptionFilter`: the body of an `HttpException`, or a `500`
 * without details for any other error, which is reported.
 */

import type { Constructor, ControllerEntry } from '../di/index.ts'
import type { Argument } from '../http/arguments.ts'
import { parseJson } from '../http/body.ts'
import type { Context, RouteInfo } from '../http/context.ts'
import type { Guard } from '../http/enhancers.ts'
import { getMethodEnhancers } from '../http/enhancers.ts'
import { ControllerError } from '../http/errors.ts'
import { HttpException, INTERNAL_ERROR_BODY } from '../http/exceptions.ts'
import { createPipeline, runGuards } from '../http/pipeline.ts'
import type { FilterStep, GuardStep } from '../http/pipeline.ts'
import { validate } from '../http/schema.ts'
import type { StandardSchemaV1 } from '../http/schema.ts'
import { methodNames } from '../utils/object.ts'
import { isThenable } from '../utils/promise.ts'
import { getSubscribedMessage } from './decorators.ts'

/** What a gateway socket carries. */
export interface GatewaySocketData {
  /** Context of the handshake request: what its guards set is read with `context.get(key)`. */
  readonly context: Context
  /** @internal */
  readonly gateway: GatewayRuntime
}

/** A connection of a gateway: Bun's `ServerWebSocket`, with `subscribe()`, `publish()`... */
export type GatewaySocket = Bun.ServerWebSocket<GatewaySocketData>

/** `handleConnection(socket)`: called when a client is connected. */
export interface OnGatewayConnection {
  handleConnection(socket: GatewaySocket): unknown
}

/** `handleDisconnect(socket, code, reason)`: called when a connection is closed. */
export interface OnGatewayDisconnect {
  handleDisconnect(socket: GatewaySocket, code: number, reason: string): unknown
}

/** Code of the close frame sent when the application shuts down. */
const GOING_AWAY = 1001

/** Runs `fn`, reporting a synchronous or asynchronous failure. */
const settle = (fn: () => unknown, report: (error: unknown) => void, then?: (value: unknown) => void): void => {
  try {
    const result = fn()

    if (isThenable(result)) {
      Promise.resolve(result).then(then, report)
    } else {
      then?.(result)
    }
  } catch (error) {
    report(error)
  }
}

/** Handles the `data` of one event for one socket; may return a promise. */
type MessageHandler = (data: unknown, socket: GatewaySocket) => unknown

/** The live part of a gateway: its sockets and handlers. */
export class GatewayRuntime {
  readonly #instance: Record<string, unknown>
  readonly #handlers: ReadonlyMap<string, MessageHandler>
  readonly #sockets = new Set<GatewaySocket>()
  readonly #onError: (error: unknown, req: Request) => void

  constructor(instance: object, handlers: ReadonlyMap<string, MessageHandler>, onError: (error: unknown, req: Request) => void) {
    this.#instance = instance as Record<string, unknown>
    this.#handlers = handlers
    this.#onError = onError
  }

  get events(): readonly string[] {
    return [...this.#handlers.keys()]
  }

  open(socket: GatewaySocket): void {
    this.#sockets.add(socket)
    this.#call('handleConnection', socket, [socket])
  }

  message(socket: GatewaySocket, message: string | Buffer): void {
    const frame = typeof message === 'string' ? parseFrame(message) : undefined
    const handler = frame === undefined ? undefined : this.#handlers.get(frame.event)

    if (handler === undefined) {
      return
    }

    settle(
      () => handler(frame!.data, socket),
      (error) => this.#fail(socket, frame!.event, error),
      (result) => {
        if (result !== undefined) {
          this.#send(socket, result)
        }
      }
    )
  }

  /** Tells the client its message failed; only an `HttpException` says why. */
  #fail(socket: GatewaySocket, event: string, error: unknown): void {
    if (error instanceof HttpException) {
      this.#send(socket, { event: 'exception', data: { ...error.response, event } })

      return
    }

    this.#onError(error, socket.data.context.req)
    this.#send(socket, { event: 'exception', data: { ...INTERNAL_ERROR_BODY, event } })
  }

  close(socket: GatewaySocket, code: number, reason: string): void {
    this.#sockets.delete(socket)
    this.#call('handleDisconnect', socket, [socket, code, reason])
  }

  /** Closes every connection, as the application shuts down. */
  closeAll(): void {
    for (const socket of this.#sockets) {
      socket.close(GOING_AWAY, 'Server shutting down')
    }
  }

  #call(hook: string, socket: GatewaySocket, args: readonly unknown[]): void {
    const fn = this.#instance[hook]

    if (typeof fn === 'function') {
      settle(
        () => fn.apply(this.#instance, args),
        (error) => this.#onError(error, socket.data.context.req)
      )
    }
  }

  #send(socket: GatewaySocket, value: unknown): void {
    try {
      // JSON.stringify throws on cycles and bigints: an application error, reported.
      socket.send(JSON.stringify(value))
    } catch (error) {
      this.#onError(error, socket.data.context.req)
    }
  }
}

const parseFrame = (message: string): { event: string; data: unknown } | undefined => {
  let frame: unknown

  try {
    frame = parseJson(message)
  } catch {
    return undefined
  }

  if (typeof frame !== 'object' || frame === null || typeof (frame as { event?: unknown }).event !== 'string') {
    return undefined
  }

  return frame as { event: string; data: unknown }
}

/** Bun's handlers for every gateway of a server: each socket knows its gateway. */
export const websocketHandler: Bun.WebSocketHandler<GatewaySocketData> = {
  open: (socket) => socket.data.gateway.open(socket),
  message: (socket, message) => socket.data.gateway.message(socket, message),
  close: (socket, code, reason) => socket.data.gateway.close(socket, code, reason),
}

/** Result of the handshake once the connection is upgraded: Bun wants no response then. */
const UPGRADED = Symbol('upgraded')

export interface GatewayParts {
  readonly entry: ControllerEntry
  readonly path: string
  /** Of the handshake: global and class guards. */
  readonly guards: readonly GuardStep[]
  readonly filters: readonly FilterStep[]
  /** Resolves the guards of a handler in the module of the gateway. */
  readonly resolveGuard: (guard: Guard) => GuardStep
  readonly metadata: ReadonlyMap<symbol, unknown>
  readonly onError: (error: unknown, req: Request) => void
  /** Names of the guards of the class, for the startup summary. */
  readonly declaredGuards: readonly string[]
}

/** A gateway ready to serve: its native route and its runtime. */
export interface BuiltGateway {
  readonly path: string
  /** The gateway class. */
  readonly gateway: Constructor<unknown>
  /** Names of the guards of the class. */
  readonly guards: readonly string[]
  readonly runtime: GatewayRuntime
  /** The native route of the handshake, for `Bun.serve({ routes })`. */
  readonly handle: (req: Bun.BunRequest, server: Bun.Server<GatewaySocketData>) => Response | undefined | Promise<Response | undefined>
}

/** Reads one argument of a message: its data, its socket, or a value of the handshake. */
type MessageReader = (data: unknown, socket: GatewaySocket) => unknown

const readerOf = (arg: Argument<unknown>, label: string): MessageReader => {
  if (arg.kind === 'message') {
    const schema = arg.source as StandardSchemaV1 | undefined

    return schema === undefined ? (data) => data : (data) => validate(schema, data, '')
  }

  if (arg.kind === 'socket') {
    return (_data, socket) => socket
  }

  if (arg.kind === 'body') {
    throw new ControllerError('INVALID_ARGUMENT', `${label}: a message has no request body, read it with data()`)
  }

  if (arg.kind === 'param') {
    throw new ControllerError('INVALID_ARGUMENT', `${label}: param('${arg.name}') names no parameter, as a gateway path has none`)
  }

  return (_data, socket) => arg.read(socket.data.context)
}

/** Calls the method with `(data, socket)`, or with the declared arguments once they are read. */
const createMessageHandler = (
  instance: object,
  method: (...args: unknown[]) => unknown,
  args: readonly Argument<unknown>[] | undefined,
  guards: readonly GuardStep[],
  label: string
): MessageHandler => {
  const readers = args?.map((arg) => readerOf(arg, label))

  const invoke: MessageHandler =
    readers === undefined
      ? (data, socket) => method.call(instance, data, socket)
      : (data, socket) => {
          const values: unknown[] = []
          let pending = false

          for (const read of readers) {
            const value = read(data, socket)

            pending ||= isThenable(value)
            values.push(value)
          }

          return pending ? Promise.all(values).then((ready) => method.apply(instance, ready)) : method.apply(instance, values)
        }

  if (guards.length === 0) {
    return invoke
  }

  // The context of the handshake: what its guards set is there for these ones.
  return (data, socket) => {
    const gate = runGuards(guards, socket.data.context, 0)

    return gate === undefined ? invoke(data, socket) : gate.then(() => invoke(data, socket))
  }
}

/** The handlers of a gateway, by event: the most derived method of an event wins. */
const collectHandlers = (parts: GatewayParts): Map<string, MessageHandler> => {
  const instance = parts.entry.instance as Record<string, (...args: unknown[]) => unknown>
  const gateway = parts.entry.controller.name
  const handlers = new Map<string, MessageHandler>()

  for (const name of methodNames(instance)) {
    const method = instance[name]!
    const subscribed = getSubscribedMessage(method)

    if (subscribed === undefined) {
      continue
    }

    const label = `${gateway}.${name}`
    const enhancers = getMethodEnhancers(method)

    if (handlers.has(subscribed.event)) {
      throw new ControllerError('DUPLICATE_ROUTE', `${label}: another method of ${gateway} handles "${subscribed.event}"`)
    }

    if (enhancers.interceptors.length > 0 || enhancers.filters.length > 0) {
      throw new ControllerError('INVALID_HANDLER', `${label}: message handlers take guards, not interceptors or exception filters`)
    }

    handlers.set(
      subscribed.event,
      createMessageHandler(instance, method, subscribed.args, enhancers.guards.map(parts.resolveGuard), label)
    )
  }

  return handlers
}

export const buildGateway = (parts: GatewayParts): BuiltGateway => {
  const runtime = new GatewayRuntime(parts.entry.instance as object, collectHandlers(parts), parts.onError)
  const route: RouteInfo = { controller: parts.entry.controller, handler: 'handshake', method: 'GET', path: parts.path, metadata: parts.metadata }
  const pipeline = createPipeline({
    route,
    guards: parts.guards,
    interceptors: [],
    filters: parts.filters,
    invoke: (ctx) =>
      (ctx.server as Bun.Server<GatewaySocketData>).upgrade(ctx.req, { data: { context: ctx, gateway: runtime } })
        ? UPGRADED
        : new Response('Expected a WebSocket upgrade', { status: 426, headers: { upgrade: 'websocket' } }),
    respond: (value) => (value === UPGRADED ? (undefined as unknown as Response) : (value as Response)),
    onError: parts.onError,
  })

  return {
    path: parts.path,
    gateway: parts.entry.controller,
    guards: parts.declaredGuards,
    runtime,
    handle: (req, server) => pipeline(req, {}, server),
  }
}
