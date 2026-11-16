/**
 * @module
 * Collects the routes of the controllers created by the container.
 *
 * Paths are built as in Nest's route path factory: global prefix, controller
 * path, method path, each with a leading slash and no trailing one; the root is `/`.
 *
 * ```ts
 * ('/api', '/users', '/:id') => '/api/users/:id'
 * ('', '/', '/')             => '/'
 * ```
 */

import { InjectionToken } from '../di/index.ts'
import type { Constructor, Container, ControllerEntry, ModuleClass } from '../di/index.ts'
import type { RouteDefinition } from '../routing/index.ts'
import { parsePath } from '../routing/path.ts'
import { methodNames } from '../utils/object.ts'
import { isThenable } from '../utils/promise.ts'
import type { Argument } from './arguments.ts'
import type { Context, RouteInfo } from './context.ts'
import { getControllerPath, getHandlerMetadata } from './decorators.ts'
import type { HandlerMetadata, RouteMetadata } from './decorators.ts'
import { getClassEnhancers, getMethodEnhancers } from './enhancers.ts'
import type { FilterLike, Guard, InterceptorLike } from './enhancers.ts'
import { ControllerError } from './errors.ts'
import { createEnhancerResolver, createPipeline } from './pipeline.ts'
import type { EnhancerResolver } from './pipeline.ts'
import { createResponder } from './response.ts'
import { createSseResponder } from './sse.ts'
import { getGatewayPath } from '../websocket/decorators.ts'
import { buildGateway } from '../websocket/gateway.ts'
import type { BuiltGateway } from '../websocket/gateway.ts'

/**
 * Options of `controllerRoutes`.
 */
export interface ControllerRoutesOptions {
  /** Prefix of every route, like Nest's `setGlobalPrefix()`: `'/api'`. */
  readonly prefix?: string
  /** Guards of every route, run first; classes are created in the root module. Like `useGlobalGuards()`. */
  readonly guards?: readonly Guard[]
  /** Interceptors of every route, outermost. Like `useGlobalInterceptors()`. */
  readonly interceptors?: readonly InterceptorLike[]
  /** Exception filters of every route, tried last. Like `useGlobalFilters()`. */
  readonly filters?: readonly FilterLike[]
  /** Receives errors that no filter answered and that are not `HttpException`s (sent as 500). Defaults to `console.error`. */
  readonly onError?: (error: unknown, req: Request) => void
}

const STATUS_CREATED = 201
const STATUS_OK = 200

/** `'users/'` → `'/users'`, `'/'` → `''`. */
const normalizePart = (part: string): string => {
  const leading = part.startsWith('/') ? part : `/${part}`

  return leading.endsWith('/') ? leading.slice(0, -1) : leading
}

const joinPaths = (...parts: readonly string[]): string => {
  let path = ''

  for (const part of parts) {
    path += normalizePart(part)
  }

  return path || '/'
}

/** Every `param()` must name a parameter of the full path, controller prefix included. */
const assertParamsExist = (args: readonly Argument<unknown>[], path: string, name: string): void => {
  const names = new Set<string>()

  for (const segment of parsePath(path)) {
    if (segment.type !== 'static' && segment.name !== undefined) {
      names.add(segment.name)
    }
  }

  for (const arg of args) {
    if (arg.kind === 'param' && !names.has(arg.name)) {
      const known = names.size === 0 ? 'it has none' : `its parameters: ${[...names].join(', ')}`

      throw new ControllerError('UNKNOWN_PARAM', `${name}: param('${arg.name}') is not a parameter of "${path}" (${known})`)
    }
  }
}

/** Calls the method with the context, or with the declared arguments once they are read. */
const createInvoker = (
  instance: object,
  method: (...args: unknown[]) => unknown,
  args: readonly Argument<unknown>[] | undefined
): ((ctx: Context) => unknown) => {
  if (args === undefined) {
    return (ctx) => method.call(instance, ctx)
  }

  const count = args.length

  return (ctx) => {
    const values: unknown[] = []
    let pending = false

    for (let i = 0; i < count; i++) {
      const value = args[i]!.read(ctx)

      pending ||= isThenable(value)
      values.push(value)
    }

    return pending ? Promise.all(values).then((ready) => method.apply(instance, ready)) : method.apply(instance, values)
  }
}

const statusOf = (metadata: HandlerMetadata, route: RouteMetadata): number =>
  metadata.status ?? (route.method.toUpperCase() === 'POST' ? STATUS_CREATED : STATUS_OK)

/** Global, class and method declarations of one kind, resolved, in Nest's order. */
const resolveAll = <T, S>(
  levels: readonly [global: readonly T[], controller: readonly T[], method: readonly T[]],
  globalResolve: (value: T) => S,
  moduleResolve: (value: T) => S
): S[] => {
  const steps: S[] = []

  for (const value of levels[0]) {
    steps.push(globalResolve(value))
  }

  for (const value of [...levels[1], ...levels[2]]) {
    steps.push(moduleResolve(value))
  }

  return steps
}

/**
 * Builds the routes of every controller.
 */
class RoutesBuilder {
  readonly routes: RouteDefinition[] = []
  readonly controllers: MappedController[] = []
  readonly gateways: BuiltGateway[] = []
  /** Routes of the controller being added. */
  #mapped: MappedRoute[] = []
  /** Guards, interceptors and filters created from classes, in creation order. */
  readonly enhancers: unknown[] = []
  readonly #options: ControllerRoutesOptions
  readonly #global: EnhancerResolver
  readonly #modules = new Map<ModuleClass, EnhancerResolver>()
  readonly #onError: (error: unknown, req: Request) => void
  readonly #track = (instance: unknown): void => {
    this.enhancers.push(instance)
  }

  constructor(container: Container, options: ControllerRoutesOptions) {
    this.#options = options
    this.#global = createEnhancerResolver((fn) => container.runInContext(fn), this.#track)
    this.#onError = options.onError ?? ((error: unknown) => console.error(error))
  }

  addController(entry: ControllerEntry): void {
    const gatewayPath = getGatewayPath(entry.controller)

    if (gatewayPath !== undefined) {
      this.#addGateway(entry, gatewayPath)

      return
    }

    const controllerPath = getControllerPath(entry.controller)

    if (controllerPath === undefined) {
      throw new ControllerError(
        'NOT_A_CONTROLLER',
        `${entry.controller.name} is listed in the controllers of ${entry.module.name} but has no @Controller()`
      )
    }

    const basePath = joinPaths(this.#options.prefix ?? '', controllerPath)

    this.#mapped = []

    // The most derived function: an override without route decorators has no metadata.
    for (const name of methodNames(entry.instance as object)) {
      this.#addMethod(entry, basePath, name)
    }

    this.controllers.push({ controller: entry.controller, path: basePath, routes: this.#mapped })
  }

  /** A gateway: its handshake gets the guards and filters of the class and the global ones. */
  #addGateway(entry: ControllerEntry, gatewayPath: string): void {
    const local = this.#resolverOf(entry)
    const controller = getClassEnhancers(entry.controller)
    const options = this.#options

    this.gateways.push(
      buildGateway({
        entry,
        path: joinPaths(options.prefix ?? '', gatewayPath),
        guards: resolveAll([options.guards ?? [], controller.guards, []], this.#global.guard, local.guard),
        filters: resolveAll([options.filters ?? [], controller.filters, []], this.#global.filter, local.filter).reverse(),
        metadata: controller.metadata,
        onError: this.#onError,
      })
    )
  }

  #resolverOf(entry: ControllerEntry): EnhancerResolver {
    let resolver = this.#modules.get(entry.module)

    if (resolver === undefined) {
      resolver = createEnhancerResolver(entry.runInContext, this.#track)
      this.#modules.set(entry.module, resolver)
    }

    return resolver
  }

  #addMethod(entry: ControllerEntry, basePath: string, name: string): void {
    const instance = entry.instance as Record<string, (...args: unknown[]) => unknown>
    const method = instance[name]!
    const metadata = getHandlerMetadata(method)

    if (metadata === undefined) {
      return
    }

    const options = this.#options
    const global = this.#global
    const local = this.#resolverOf(entry)
    const controller = getClassEnhancers(entry.controller)
    const own = getMethodEnhancers(method)
    const guards = resolveAll([options.guards ?? [], controller.guards, own.guards], global.guard, local.guard)
    const interceptors = resolveAll(
      [options.interceptors ?? [], controller.interceptors, own.interceptors],
      global.interceptor,
      local.interceptor
    )
    // Tried the other way round: method first, global last.
    const filters = resolveAll([options.filters ?? [], controller.filters, own.filters], global.filter, local.filter).reverse()
    const routeMetadata = new Map([...controller.metadata, ...own.metadata])

    for (const route of metadata.routes) {
      const path = joinPaths(basePath, route.path)
      const info: RouteInfo = { controller: entry.controller, handler: name, method: route.method, path, metadata: routeMetadata }

      if (route.args !== undefined) {
        assertParamsExist(route.args, path, `${entry.controller.name}.${name}`)
      }

      const status = statusOf(metadata, route)

      this.#mapped.push({ info, args: route.args, status, sse: route.sse })
      this.routes.push({
        method: route.method,
        path,
        name: `${entry.controller.name}.${name}`,
        handler: createPipeline({
          route: info,
          guards,
          interceptors,
          filters,
          invoke: createInvoker(instance, method, route.args),
          respond: route.sse ? createSseResponder(metadata.headers, this.#onError) : createResponder(status, metadata.headers),
          onError: this.#onError,
        }),
      })
    }
  }
}

/** A route as declared: what startup logs and API descriptions (OpenAPI) show. */
export interface MappedRoute {
  /** Controller, method name, HTTP method, full path and custom metadata. */
  readonly info: RouteInfo
  /** Declared arguments; `undefined` when the method receives the context. */
  readonly args: readonly Argument<unknown>[] | undefined
  /** Status of the responses built from returned values. */
  readonly status: number
  /** Declared with `@Sse()`. */
  readonly sse: boolean
}

/** A controller and the routes made from it. */
export interface MappedController {
  readonly controller: Constructor<unknown>
  /** Path of the controller, with the global prefix. */
  readonly path: string
  readonly routes: readonly MappedRoute[]
}

/**
 * The routes of the application, grouped by controller: `inject(ROUTES)`.
 * Filled once the routes are built, so read it when serving, not in a constructor.
 */
export interface RouteRegistry {
  readonly controllers: readonly MappedController[]
}

export const ROUTES = new InjectionToken<RouteRegistry>('ROUTES')

/**
 * Routes of every controller, and the guards, interceptors and filters created
 * for them from classes (whose lifecycle hooks the application runs).
 */
export interface BuiltRoutes {
  readonly routes: RouteDefinition[]
  /** In module order. */
  readonly controllers: readonly MappedController[]
  /** WebSocket gateways, in module order. */
  readonly gateways: readonly BuiltGateway[]
  /** In creation order. */
  readonly enhancers: readonly unknown[]
}

/**
 * Builds the routes of every controller of `container`.
 */
export const buildRoutes = (container: Container, options: ControllerRoutesOptions = {}): BuiltRoutes => {
  const builder = new RoutesBuilder(container, options)

  for (const entry of container.controllers) {
    builder.addController(entry)
  }

  return { routes: builder.routes, controllers: builder.controllers, gateways: builder.gateways, enhancers: builder.enhancers }
}

/**
 * Route definitions of every controller of `container`, ready for `compileRoutes`.
 * `createApp` does this and also runs the lifecycle hooks of guards, interceptors and filters.
 *
 * ```ts
 * const container = await createContainer(AppModule)
 * const server = Bun.serve({ port: 3000, ...compileRoutes(controllerRoutes(container, { guards: [AuthGuard] })) })
 * ```
 */
export const controllerRoutes = (container: Container, options: ControllerRoutesOptions = {}): RouteDefinition[] =>
  buildRoutes(container, options).routes
