/**
 * @module
 * Controller and route decorators (standard TC39 decorators).
 *
 * As in Nest, route metadata is attached to the method function itself (Nest
 * uses `Reflect.defineMetadata(..., descriptor.value)`, here a WeakMap keyed by
 * the function). Routes are then found by walking the prototype chain, so a
 * controller inherits the routes of its parent class, and an override without
 * a route decorator removes the route.
 *
 * ```ts
 * @Controller('/users')
 * class UsersController {
 *   readonly #users = inject(UsersService)
 *
 *   @Get('/:id')
 *   findOne(ctx: Context<{ id: string }>) {
 *     return this.#users.find(ctx.params.id)
 *   }
 *
 *   @Post()
 *   @HttpCode(202)
 *   @Header('cache-control', 'no-store')
 *   async create(ctx: Context) {
 *     return this.#users.create(await ctx.req.json())
 *   }
 * }
 * ```
 */

import type { Constructor } from '../di/index.ts'
import type { Argument, ArgumentFor, ArgumentValues } from './arguments.ts'
import type { Context } from './context.ts'
import { ControllerError } from './errors.ts'

/**
 * Route declared on a method.
 */
export interface RouteMetadata {
  readonly method: string
  readonly path: string
  /** Declared arguments; `undefined` when the method receives the context. */
  readonly args: readonly Argument<unknown>[] | undefined
  /** Declared with `@Sse()`: the result is streamed as server-sent events. */
  readonly sse: boolean
}

/**
 * Everything the decorators recorded for one method.
 */
export interface HandlerMetadata {
  /** In declaration order, top to bottom. */
  readonly routes: RouteMetadata[]
  status: number | undefined
  /** In declaration order, top to bottom; a name may repeat. */
  readonly headers: [string, string][]
}

/**
 * Method of a route without argument list: it takes the context of its path,
 * a plain `Context` (any path), or nothing.
 */
export type RouteHandlerMethod<This, P extends string> =
  | ((this: This, ctx: Context<P>) => unknown)
  | ((this: This, ctx: Context) => unknown)

/**
 * Decorator of a route without argument list: `@Get(':id')`.
 */
export type RouteDecorator<P extends string> = <This, M extends (this: This, ...args: any[]) => unknown>(
  method: M extends RouteHandlerMethod<This, P> ? M : RouteHandlerHint<P>,
  context: ClassMethodDecoratorContext<This, M>
) => void

/**
 * What the compiler shows for a method that does not fit a route without
 * argument list, such as `findOne(id: string)` under `@Get(':id')`.
 */
export type RouteHandlerHint<P extends string> =
  `Without an argument list, the method receives the context: (ctx: Context<'${P}'>). To receive values, list them: @Get('${P}', [param('name')]).`

/**
 * Decorator of a route with an argument list: `@Get(':id', [param('id', int())])`.
 * The method must accept the values of the arguments, in order.
 */
export type ArgumentsRouteDecorator<A extends readonly Argument<unknown>[], P extends string = string> = <
  This,
  M extends (this: This, ...args: ArgumentValues<A, P>) => unknown,
>(
  method: M,
  context: ClassMethodDecoratorContext<This, M>
) => void

/**
 * `@Get`, `@Post`... : path and argument list are both optional.
 *
 * ```ts
 * @Get()                                         // list(ctx?: Context)
 * @Get(':id')                                    // findOne(ctx: Context<':id'>)
 * @Get(':id', [param('id', int())])              // findOne(id: number)
 * @Post([body(CreateUserDto)])                   // create(dto: CreateUserDto)
 * ```
 */
export interface RouteDecoratorFactory {
  <const P extends string = '/'>(path?: P): RouteDecorator<P>
  <const P extends string, const A extends readonly ArgumentFor<P>[]>(path: P, args: A): ArgumentsRouteDecorator<A, P>
  <const A extends readonly ArgumentFor<'/'>[]>(args: A): ArgumentsRouteDecorator<A, '/'>
}

/**
 * Decorator returned by `@HttpCode()` and `@Header()`: fits any method.
 * The constraint is the one `ClassMethodDecoratorContext` itself requires.
 */
// oxlint-disable-next-line typescript/no-explicit-any
export type MethodMetadataDecorator = <This, M extends (this: This, ...args: any) => any>(
  method: M,
  context: ClassMethodDecoratorContext<This, M>
) => void

/** The part of a method decorator context the checks read. */
interface MethodContext {
  readonly name: string | symbol
  readonly static: boolean
  readonly private: boolean
}

const controllers = new WeakMap<Constructor<unknown>, string>()
const handlers = new WeakMap<object, HandlerMetadata>()

/** Statuses a `Response` accepts. */
const MIN_STATUS = 200
const MAX_STATUS = 599

const metadataOf = (method: object): HandlerMetadata => {
  let metadata = handlers.get(method)

  if (metadata === undefined) {
    metadata = { routes: [], status: undefined, headers: [] }
    handlers.set(method, metadata)
  }

  return metadata
}

/**
 * Rejects decorators on static, private (`#name`) or symbol-named methods: routes are
 * found as public methods on the prototype chain, like Nest's metadata scanner does.
 */
const assertPublicMethod = (decorator: string, context: MethodContext): void => {
  if (context.static || context.private || typeof context.name !== 'string') {
    throw new ControllerError(
      'INVALID_HANDLER',
      `@${decorator}() must decorate a public instance method with a string name, not ${String(context.name)}`
    )
  }
}

/**
 * Declares a controller. `path` prefixes every route of the class.
 *
 * ```ts
 * @Controller('/users')
 * class UsersController {}
 * ```
 */
export const Controller =
  (path = '/') =>
  (target: Constructor<unknown>, _context: ClassDecoratorContext<Constructor<unknown>>): void => {
    controllers.set(target, path)
  }

/**
 * Creates the route decorator factory of one HTTP method (any method name, extensions included).
 */
const routeFactory = (method: string, decorator: string, sse = false): RouteDecoratorFactory =>
  ((pathOrArgs?: string | readonly Argument<unknown>[], args?: readonly Argument<unknown>[]) =>
    (target: object, context: MethodContext) => {
      assertPublicMethod(decorator, context)

      const path = typeof pathOrArgs === 'string' ? pathOrArgs : '/'
      const list = typeof pathOrArgs === 'string' ? args : pathOrArgs

      // Decorators run bottom-up: unshift keeps the source order.
      metadataOf(target).routes.unshift({ method, path, args: list, sse })
    }) as RouteDecoratorFactory

/**
 * `@Route`: like `@Get`, with the method name first.
 */
export interface MethodRouteDecoratorFactory {
  <const P extends string = '/'>(method: string, path?: P): RouteDecorator<P>
  <const P extends string, const A extends readonly ArgumentFor<P>[]>(
    method: string,
    path: P,
    args: A
  ): ArgumentsRouteDecorator<A, P>
  <const A extends readonly ArgumentFor<'/'>[]>(method: string, args: A): ArgumentsRouteDecorator<A, '/'>
}

/**
 * Route for any method name, including extensions (`PROPFIND`, `REPORT`...).
 * Like the others, it may be repeated on one method to serve several routes.
 */
export const Route = ((method: string, pathOrArgs?: string | readonly Argument<unknown>[], args?: readonly Argument<unknown>[]) =>
  (routeFactory(method, 'Route') as (path?: typeof pathOrArgs, list?: typeof args) => unknown)(
    pathOrArgs,
    args
  )) as MethodRouteDecoratorFactory

/** `GET` route. */
export const Get = routeFactory('GET', 'Get')
/** `POST` route; answers `201 Created` unless `@HttpCode()` says otherwise. */
export const Post = routeFactory('POST', 'Post')
/** `PUT` route. */
export const Put = routeFactory('PUT', 'Put')
/** `PATCH` route. */
export const Patch = routeFactory('PATCH', 'Patch')
/** `DELETE` route. */
export const Delete = routeFactory('DELETE', 'Delete')
/** `OPTIONS` route. */
export const Options = routeFactory('OPTIONS', 'Options')
/** `HEAD` route; without it, `HEAD` is served by the `GET` route. */
export const Head = routeFactory('HEAD', 'Head')
/** Route for every method; a route for a concrete method on the same path wins. */
export const All = routeFactory('ALL', 'All')

/**
 * `GET` route streaming server-sent events: the method returns an async
 * iterable of `SseMessage`, such as an `async function*`. Like Nest's `@Sse()`.
 */
export const Sse = routeFactory('GET', 'Sse', true)

/**
 * Status of the responses built from the returned value (not of a returned `Response`).
 * Defaults to `201` for `POST` and `200` otherwise, as in Nest.
 */
export const HttpCode =
  (status: number): MethodMetadataDecorator =>
  (target, context) => {
    assertPublicMethod('HttpCode', context)

    if (!Number.isInteger(status) || status < MIN_STATUS || status > MAX_STATUS) {
      throw new ControllerError('INVALID_STATUS', `@HttpCode(${status}): a response status is an integer from 200 to 599`)
    }

    const metadata = metadataOf(target)

    if (metadata.status !== undefined) {
      throw new ControllerError('INVALID_STATUS', `${String(context.name)} has more than one @HttpCode()`)
    }

    metadata.status = status
  }

/**
 * Header added to the responses built from the returned value (not to a returned `Response`).
 */
export const Header =
  (name: string, value: string): MethodMetadataDecorator =>
  (target, context) => {
    assertPublicMethod('Header', context)

    try {
      new Headers([[name, value]])
    } catch (error) {
      throw new ControllerError('INVALID_HEADER', `@Header(${JSON.stringify(name)}, ...): ${(error as Error).message}`)
    }

    metadataOf(target).headers.unshift([name, value])
  }

/** Path of a `@Controller()` class, `undefined` if the class is not a controller. */
export const getControllerPath = (target: Constructor<unknown>): string | undefined => controllers.get(target)

/** Metadata of a method, `undefined` if no decorator touched it. */
export const getHandlerMetadata = (method: unknown): HandlerMetadata | undefined =>
  typeof method === 'function' ? handlers.get(method) : undefined
