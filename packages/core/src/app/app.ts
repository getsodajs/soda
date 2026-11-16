/**
 * @module
 * The application: container, routes and server, started and stopped together.
 *
 * ```ts
 * const app = await createApp(AppModule, { prefix: '/api' })
 *
 * app.enableShutdownSignals()
 * await app.listen(3000)
 * ```
 *
 * Startup creates the container (every singleton, every `onInit`), then the
 * guards, interceptors and filters (their `onInit` too), and only then accepts
 * requests.
 *
 * Shutdown stops accepting requests first and waits for the ones in flight,
 * then runs `onDestroy` (guards and the like, then the container). Nest closes
 * the server after `onModuleDestroy`, so requests still arrive while services
 * are being destroyed; here they cannot.
 */

import { createContainer, provide } from '../di/index.ts'
import type { Container, ContainerOptions, ModuleImport } from '../di/index.ts'
import { destroyAll, initializeAll } from '../di/lifecycle.ts'
import { buildRoutes, ControllerError, ROUTES } from '../http/index.ts'
import type { ControllerRoutesOptions, MappedController, Middleware } from '../http/index.ts'
import { errorResponse } from '../http/exceptions.ts'
import { applyMiddleware, resolveMiddleware } from '../http/middleware.ts'
import { ConsoleLogger, Logger, SilentLogger } from '../logger/index.ts'
import { compileRoutes } from '../routing/index.ts'
import type { CompiledRoutes, CompileOptions, NativeHandler } from '../routing/index.ts'
import { websocketHandler } from '../websocket/gateway.ts'
import type { BuiltGateway, GatewaySocketData } from '../websocket/gateway.ts'
import { release, takeOver } from './hot.ts'

/**
 * Options of `createApp`.
 */
export interface AppOptions extends ContainerOptions, ControllerRoutesOptions, CompileOptions {
  /**
   * Middleware run around every request, before routing (404 and preflights
   * included), first one outermost: `[cors(), requestId]`.
   */
  readonly middleware?: readonly Middleware[]
  /**
   * Logger of the application, injectable everywhere as `inject(Logger)`.
   * Defaults to a `ConsoleLogger`; `false` writes nothing.
   */
  readonly logger?: Logger | false
}

/**
 * Where to listen. `port: 0` picks a free port.
 */
export interface ListenOptions {
  readonly port?: number
  readonly hostname?: string
  /**
   * Largest request body accepted, in bytes; bigger ones are refused before any
   * handler runs. Bun's default is 128 MiB.
   */
  readonly maxRequestBodySize?: number
  /**
   * Limits of WebSocket connections, Bun's defaults otherwise: frames up to
   * `maxPayloadLength` bytes (16 MiB; a bigger one closes the connection with
   * `1009`), `idleTimeout` seconds without traffic (120) before closing.
   */
  readonly websocket?: Pick<Bun.WebSocketHandler<GatewaySocketData>, 'maxPayloadLength' | 'idleTimeout' | 'backpressureLimit' | 'sendPings' | 'perMessageDeflate'>
}

/** Signals `enableShutdownSignals()` listens to by default. */
const DEFAULT_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT']

/**
 * A created application.
 */
export interface App {
  readonly container: Container
  /** Routes (and WebSocket handlers) for `Bun.serve()`, when serving them yourself instead of calling `listen()`. */
  readonly routes: ServeRoutes
  /** The server once `listen()` resolved. */
  readonly server: Bun.Server<GatewaySocketData> | undefined
  /**
   * Starts serving. Under `bun --hot`, a new version of the application
   * listening on the same port takes the server over from the previous one,
   * which is then destroyed (its server is not stopped: it is shared).
   */
  listen(options?: number | ListenOptions): Promise<Bun.Server<GatewaySocketData>>
  /**
   * Graceful shutdown: refuses new requests, waits for those in flight, then
   * runs `onDestroy` hooks. Safe to call more than once, even from a hook.
   */
  close(): Promise<void>
  /**
   * Closes the application on `SIGTERM` and `SIGINT` (or `signals`), then lets
   * the signal terminate the process. Off by default, as Nest's `enableShutdownHooks()`.
   */
  enableShutdownSignals(signals?: readonly NodeJS.Signals[]): this
}

class Application implements App {
  readonly container: Container
  readonly routes: ServeRoutes
  #server: Bun.Server<GatewaySocketData> | undefined
  /** Set when a new version took the server over: it must not be stopped. */
  #handedOver = false
  #closing: Promise<void> | undefined
  readonly #enhancers: readonly unknown[]
  readonly #signals = new Map<NodeJS.Signals, () => void>()
  readonly #logger: Logger
  readonly #gateways: readonly BuiltGateway[]

  constructor(
    container: Container,
    routes: ServeRoutes,
    gateways: readonly BuiltGateway[],
    enhancers: readonly unknown[],
    logger: Logger
  ) {
    this.container = container
    this.routes = routes
    this.#gateways = gateways
    this.#enhancers = enhancers
    this.#logger = logger
  }

  get server(): Bun.Server<GatewaySocketData> | undefined {
    return this.#server
  }

  async listen(options: number | ListenOptions = {}): Promise<Bun.Server<GatewaySocketData>> {
    if (this.#closing !== undefined) {
      throw new Error('Cannot listen: the application is closed')
    }

    if (this.#server !== undefined) {
      throw new Error(`The application already listens on ${this.#server.url.href}`)
    }

    const { port = 0, hostname, maxRequestBodySize, websocket } = typeof options === 'number' ? { port: options } : options

    const server = Bun.serve({ port, hostname, maxRequestBodySize, ...this.routes, websocket: { ...this.routes.websocket, ...websocket } })

    this.#server = server

    if (server.port !== undefined) {
      await takeOver(server.port, this)
    }

    this.#logger.log(`Listening on ${server.url.href}`)

    return server
  }

  /** Destroys this version without stopping the server a newer version now uses. */
  handOver(): Promise<void> {
    this.#handedOver = true

    return this.close()
  }

  close(): Promise<void> {
    if (this.#closing === undefined) {
      // Assigned before anything runs, so a hook calling close() gets this promise.
      const { promise, resolve, reject } = Promise.withResolvers<void>()

      this.#closing = promise
      this.#shutdown().then(resolve, reject)
    }

    return this.#closing
  }

  enableShutdownSignals(signals: readonly NodeJS.Signals[] = DEFAULT_SIGNALS): this {
    for (const signal of signals) {
      if (this.#signals.has(signal)) {
        continue
      }

      const listener = (): void => {
        // A second signal while closing is ignored: the first one finishes the job.
        if (this.#closing !== undefined) {
          return
        }

        this.close().then(
          () => {
            this.#removeSignalListeners()
            // Terminate as the signal would have, exit code included.
            process.kill(process.pid, signal)
          },
          (error: unknown) => {
            this.#logger.fatal('Shutdown failed', { error })
            process.exit(1)
          }
        )
      }

      this.#signals.set(signal, listener)
      process.on(signal, listener)
    }

    return this
  }

  async #shutdown(): Promise<void> {
    const server = this.#server

    try {
      // Open sockets would keep stop() waiting; under --hot, clients reconnect to the new version.
      for (const gateway of this.#gateways) {
        gateway.runtime.closeAll()
      }

      if (server !== undefined && !this.#handedOver) {
        await server.stop()
      }

      await destroyEverything(this.#enhancers, this.container)
    } finally {
      // Whatever happened, signals get their default behaviour back.
      this.#removeSignalListeners()

      if (server?.port !== undefined) {
        release(server.port, this)
      }
    }
  }

  #removeSignalListeners(): void {
    for (const [signal, listener] of this.#signals) {
      process.off(signal, listener)
    }

    this.#signals.clear()
  }
}

const errorsOf = (error: unknown): unknown[] => (error instanceof AggregateError ? error.errors : [error])

/**
 * Destroys guards and the like, then the container; every hook runs.
 * One failure is rethrown as is, several as an `AggregateError`.
 */
const destroyEverything = async (enhancers: readonly unknown[], container: Container): Promise<void> => {
  const errors: unknown[] = []

  try {
    await destroyAll(enhancers)
  } catch (error) {
    errors.push(...errorsOf(error))
  }

  try {
    await container.close()
  } catch (error) {
    errors.push(...errorsOf(error))
  }

  if (errors.length === 1) {
    throw errors[0]
  }

  if (errors.length > 1) {
    throw new AggregateError(errors, `${errors.length} onDestroy hooks failed`)
  }
}

/**
 * Routes and WebSocket handlers for `Bun.serve()`: the handshakes of gateways
 * are native routes of their own, outside middleware, as an upgrade returns no response.
 */
export interface ServeRoutes {
  readonly routes: Record<string, NativeHandler | BuiltGateway['handle']>
  readonly fetch: CompiledRoutes['fetch']
  readonly websocket: Bun.WebSocketHandler<GatewaySocketData>
}

const withGateways = (compiled: CompiledRoutes, gateways: readonly BuiltGateway[]): ServeRoutes => {
  const routes: ServeRoutes['routes'] = { ...compiled.routes }

  for (const gateway of gateways) {
    if (Object.hasOwn(routes, gateway.path)) {
      throw new ControllerError('DUPLICATE_ROUTE', `The WebSocket gateway on ${gateway.path} has the path of another gateway or route`)
    }

    routes[gateway.path] = gateway.handle
  }

  return { routes, fetch: compiled.fetch, websocket: websocketHandler }
}

/** What Nest logs at startup: the modules, then each controller and its routes. */
const logStartup = (
  logger: Logger,
  container: Container,
  controllers: readonly MappedController[],
  gateways: readonly BuiltGateway[]
): void => {
  const modules = logger.child('Container')
  const routes = logger.child('Routes')

  for (const module of container.modules) {
    modules.log(`${module.name} dependencies initialized`)
  }

  for (const { controller, path, routes: mapped } of controllers) {
    routes.log(`${controller.name} {${path}}:`)

    for (const { info } of mapped) {
      routes.log(`Mapped {${info.path}, ${info.method}} route`)
    }
  }

  for (const gateway of gateways) {
    routes.log(`WebSocket gateway {${gateway.path}}, events: ${gateway.runtime.events.join(', ') || 'none'}`)
  }
}

/**
 * Creates the container and the routes, and runs every `onInit` hook.
 *
 * If anything fails, what was created is destroyed and the error is rethrown;
 * if destroying fails too, everything comes as one `AggregateError`, startup
 * error first, as `createContainer` does.
 */
export const createApp = async (root: ModuleImport, options: AppOptions = {}): Promise<App> => {
  const logger = options.logger === false ? new SilentLogger() : (options.logger ?? new ConsoleLogger())
  const own = logger.child('Soda')
  const onError =
    options.onError ??
    ((error: unknown, req: Request) =>
      own.error('Unhandled error while handling a request', { error, method: req.method, url: req.url }))

  own.log('Starting application')

  // Filled once the routes are built; read by what describes them (OpenAPI).
  const registry: { controllers: readonly MappedController[] } = { controllers: [] }
  const container = await createContainer(root, {
    ...options,
    providers: [...(options.providers ?? []), provide(Logger, { useValue: logger }), provide(ROUTES, { useValue: registry })],
  })
  const enhancers: unknown[] = []

  try {
    // Middleware first: it wraps everything, so it is initialized first and destroyed last.
    const middleware = resolveMiddleware(options.middleware ?? [], (fn) => container.runInContext(fn), (instance) => {
      enhancers.push(instance)
    })
    const built = buildRoutes(container, { ...options, onError })

    registry.controllers = built.controllers
    logStartup(logger, container, built.controllers, built.gateways)
    enhancers.push(...built.enhancers)
    await initializeAll(enhancers)
    own.log('Application started')

    const compiled = compileRoutes(built.routes, options)
    const routes = applyMiddleware(middleware, compiled.routes, compiled.fetch, (error, req) =>
      errorResponse(error, (unknown) => onError(unknown, req))
    )

    return new Application(container, withGateways(routes, built.gateways), built.gateways, enhancers, own)
  } catch (error) {
    try {
      await destroyEverything(enhancers, container)
    } catch (destroyError) {
      throw new AggregateError([error, ...errorsOf(destroyError)], 'Startup failed, and onDestroy hooks failed while rolling back')
    }

    throw error
  }
}
