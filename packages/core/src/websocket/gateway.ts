/**
 * @module
 * Serving a gateway: the handshake goes through the route pipeline (guards
 * and exception filters of the gateway), then frames are dispatched to its
 * `@SubscribeMessage()` methods.
 *
 * The protocol is the one of Nest's `WsAdapter`: text frames holding
 * `{ "event": string, "data": any }`. Frames that are not JSON, not such an
 * object, or name no handled event are dropped silently, as anyone can send
 * them; errors of the gateway's own code are reported.
 */

import type { ControllerEntry } from '../di/index.ts'
import { parseJson } from '../http/body.ts'
import type { Context, RouteInfo } from '../http/context.ts'
import { createPipeline } from '../http/pipeline.ts'
import type { FilterStep, GuardStep } from '../http/pipeline.ts'
import { methodNames } from '../utils/object.ts'
import { isThenable } from '../utils/promise.ts'
import { getSubscribedEvent } from './decorators.ts'

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

/** The live part of a gateway: its sockets and handlers. */
export class GatewayRuntime {
  readonly #instance: Record<string, unknown>
  readonly #handlers = new Map<string, (data: unknown, socket: GatewaySocket) => unknown>()
  readonly #sockets = new Set<GatewaySocket>()
  readonly #onError: (error: unknown, req: Request) => void

  constructor(instance: object, onError: (error: unknown, req: Request) => void) {
    this.#instance = instance as Record<string, unknown>
    this.#onError = onError

    for (const name of methodNames(instance)) {
      const method = this.#instance[name] as (data: unknown, socket: GatewaySocket) => unknown
      const event = getSubscribedEvent(method)

      if (event !== undefined) {
        this.#handlers.set(event, method)
      }
    }
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
      () => handler.call(this.#instance, frame!.data, socket),
      (error) => this.#onError(error, socket.data.context.req),
      (result) => {
        if (result !== undefined) {
          this.#send(socket, result)
        }
      }
    )
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
  readonly guards: readonly GuardStep[]
  readonly filters: readonly FilterStep[]
  readonly metadata: ReadonlyMap<symbol, unknown>
  readonly onError: (error: unknown, req: Request) => void
}

/** A gateway ready to serve: its native route and its runtime. */
export interface BuiltGateway {
  readonly path: string
  readonly runtime: GatewayRuntime
  /** The native route of the handshake, for `Bun.serve({ routes })`. */
  readonly handle: (req: Bun.BunRequest, server: Bun.Server<GatewaySocketData>) => Response | undefined | Promise<Response | undefined>
}

export const buildGateway = (parts: GatewayParts): BuiltGateway => {
  const runtime = new GatewayRuntime(parts.entry.instance as object, parts.onError)
  const route: RouteInfo = { controller: parts.entry.controller, handler: 'handshake', method: 'GET', path: parts.path, metadata: parts.metadata }
  // The pipeline is built once; the server of each request is found here.
  const servers = new WeakMap<Request, Bun.Server<GatewaySocketData>>()
  const pipeline = createPipeline({
    route,
    guards: parts.guards,
    interceptors: [],
    filters: parts.filters,
    invoke: (ctx) =>
      servers.get(ctx.req)!.upgrade(ctx.req, { data: { context: ctx, gateway: runtime } })
        ? UPGRADED
        : new Response('Expected a WebSocket upgrade', { status: 426, headers: { upgrade: 'websocket' } }),
    respond: (value) => (value === UPGRADED ? (undefined as unknown as Response) : (value as Response)),
    onError: parts.onError,
  })

  return {
    path: parts.path,
    runtime,
    handle: (req, server) => {
      servers.set(req, server)

      return pipeline(req, {})
    },
  }
}
