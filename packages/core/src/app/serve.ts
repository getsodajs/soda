/**
 * @module
 * What `Bun.serve()` receives: compiled routes, and the handshakes of gateways.
 */

import { ControllerError } from '../http/index.ts'
import type { CompiledRoutes, NativeHandler } from '../routing/index.ts'
import { websocketHandler } from '../websocket/gateway.ts'
import type { BuiltGateway, GatewaySocketData } from '../websocket/gateway.ts'

/**
 * Routes and WebSocket handlers for `Bun.serve()`: the handshakes of gateways
 * are native routes of their own, outside middleware, as an upgrade returns no response.
 */
export interface ServeRoutes {
  readonly routes: Record<string, NativeHandler | BuiltGateway['handle']>
  readonly fetch: CompiledRoutes['fetch']
  readonly websocket: Bun.WebSocketHandler<GatewaySocketData>
}

export const withGateways = (compiled: CompiledRoutes, gateways: readonly BuiltGateway[]): ServeRoutes => {
  const routes: ServeRoutes['routes'] = { ...compiled.routes }

  for (const gateway of gateways) {
    if (Object.hasOwn(routes, gateway.path)) {
      throw new ControllerError('DUPLICATE_ROUTE', `The WebSocket gateway on ${gateway.path} has the path of another gateway or route`)
    }

    routes[gateway.path] = gateway.handle
  }

  return { routes, fetch: compiled.fetch, websocket: websocketHandler }
}
