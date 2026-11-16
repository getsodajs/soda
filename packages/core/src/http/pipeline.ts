/**
 * @module
 * Builds the request pipeline of one route, once, at startup.
 *
 * ```
 * guards → interceptors → arguments → handler → response
 *   └──────────── exception filters (method, class, global) → base handler
 * ```
 *
 * Synchronous steps stay synchronous: a route without async guards,
 * interceptors or body reading never allocates a promise, and a route without
 * enhancers is the bare handler call.
 */

import type { ClassToken, Constructor } from '../di/index.ts'
import type { Handler } from '../routing/index.ts'
import { isThenable } from '../utils/promise.ts'
import { Context } from './context.ts'
import type { RouteInfo } from './context.ts'
import { getCaughtExceptions } from './enhancers.ts'
import type { CallHandler, CanActivate, ExceptionFilter, FilterLike, Guard, Interceptor, InterceptorLike } from './enhancers.ts'
import { errorResponse, ForbiddenException } from './exceptions.ts'

export type GuardStep = (ctx: Context) => unknown
export type InterceptorStep = (ctx: Context, next: CallHandler) => unknown

export interface FilterStep {
  /** Empty: catches everything. */
  readonly types: readonly ClassToken<unknown>[]
  readonly handle: (error: unknown, ctx: Context) => Response | Promise<Response>
}

/**
 * Turns enhancer declarations into callable steps for one module.
 */
export interface EnhancerResolver {
  readonly guard: (guard: Guard) => GuardStep
  readonly interceptor: (interceptor: InterceptorLike) => InterceptorStep
  readonly filter: (filter: FilterLike) => FilterStep
}

/**
 * Creates the resolver of a module: classes are created once per module where
 * `inject()` sees that module, functions run there on each call.
 *
 * Every instance created from a class is passed to `onCreate`, in creation
 * order, so that the application runs its lifecycle hooks. Instances given to
 * the decorators belong to whoever created them.
 */
export const createEnhancerResolver = (
  runInContext: <R>(fn: () => R) => R,
  onCreate: (instance: unknown) => void
): EnhancerResolver => {
  const instances = new Map<Constructor<unknown>, unknown>()

  const instanceOf = <T>(enhancerClass: Constructor<T>): T => {
    let instance = instances.get(enhancerClass) as T | undefined

    if (instance === undefined) {
      instance = runInContext(() => new enhancerClass())
      instances.set(enhancerClass, instance)
      onCreate(instance)
    }

    return instance
  }

  const isClass = (value: unknown, method: string): value is Constructor<unknown> =>
    typeof value === 'function' && typeof (value.prototype as Record<string, unknown> | undefined)?.[method] === 'function'

  return {
    guard: (guard) => {
      if (isClass(guard, 'canActivate')) {
        const instance = instanceOf(guard as Constructor<CanActivate>)

        return (ctx) => instance.canActivate(ctx)
      }

      if (typeof guard === 'function') {
        return (ctx) => runInContext(() => guard(ctx))
      }

      return (ctx) => guard.canActivate(ctx)
    },
    interceptor: (interceptor) => {
      if (isClass(interceptor, 'intercept')) {
        const instance = instanceOf(interceptor as Constructor<Interceptor>)

        return (ctx, next) => instance.intercept(ctx, next)
      }

      if (typeof interceptor === 'function') {
        return (ctx, next) => runInContext(() => interceptor(ctx, next))
      }

      return (ctx, next) => interceptor.intercept(ctx, next)
    },
    filter: (filter) => {
      if (isClass(filter, 'catch')) {
        const instance = instanceOf(filter as Constructor<ExceptionFilter>)

        return { types: getCaughtExceptions(filter), handle: (error, ctx) => instance.catch(error, ctx) }
      }

      if (typeof filter === 'function') {
        return { types: [], handle: (error, ctx) => runInContext(() => filter(error, ctx)) }
      }

      return { types: getCaughtExceptions(filter), handle: (error, ctx) => filter.catch(error, ctx) }
    },
  }
}

const FORBIDDEN_MESSAGE = 'Forbidden resource'

/** Runs a step, turning a synchronous throw into a rejection. */
const settle = (step: () => unknown): Promise<unknown> => {
  try {
    return Promise.resolve(step())
  } catch (error) {
    return Promise.reject(error)
  }
}

/** Runs guards from `index`; synchronous as long as the guards are. A refusal is a `403`. */
export const runGuards = (guards: readonly GuardStep[], ctx: Context, index: number): void | Promise<void> => {
  for (let i = index, len = guards.length; i < len; i++) {
    const allowed = guards[i]!(ctx)

    if (isThenable(allowed)) {
      return Promise.resolve(allowed).then((value) => {
        if (!value) {
          throw new ForbiddenException(FORBIDDEN_MESSAGE)
        }

        return runGuards(guards, ctx, i + 1)
      })
    }

    if (!allowed) {
      throw new ForbiddenException(FORBIDDEN_MESSAGE)
    }
  }

  return undefined
}

/** Wraps `invoke` with the interceptors, outermost first. */
const withInterceptors = (
  interceptors: readonly InterceptorStep[],
  invoke: (ctx: Context) => unknown
): ((ctx: Context) => unknown) => {
  const count = interceptors.length

  if (count === 0) {
    return invoke
  }

  return (ctx) => {
    const call = (index: number): Promise<unknown> =>
      index === count ? settle(() => invoke(ctx)) : settle(() => interceptors[index]!(ctx, () => call(index + 1)))

    return interceptors[0]!(ctx, () => call(1))
  }
}

/**
 * Pipeline parts of one route, enhancers already resolved and ordered.
 */
export interface PipelineParts {
  readonly route: RouteInfo
  readonly guards: readonly GuardStep[]
  readonly interceptors: readonly InterceptorStep[]
  /** In the order they are tried: method, class, global. */
  readonly filters: readonly FilterStep[]
  readonly invoke: (ctx: Context) => unknown
  readonly respond: (value: unknown, ctx: Context) => Response
  readonly onError: (error: unknown, req: Request) => void
}

const selectFilter = (filters: readonly FilterStep[], error: unknown): FilterStep | undefined => {
  for (const filter of filters) {
    if (filter.types.length === 0) {
      return filter
    }

    for (const type of filter.types) {
      if (error instanceof type) {
        return filter
      }
    }
  }

  return undefined
}

/**
 * Builds the route handler given to the router.
 */
export const createPipeline = (parts: PipelineParts): Handler => {
  const { route, guards, filters, respond, onError } = parts
  const run = withInterceptors(parts.interceptors, parts.invoke)
  const hasGuards = guards.length > 0

  const base = (error: unknown, req: Request): Response => errorResponse(error, (unknown) => onError(unknown, req))

  /** Exception filters, then the base handler; a failing filter falls back to the base handler. */
  const fail = (error: unknown, ctx: Context): Response | Promise<Response> => {
    const filter = selectFilter(filters, error)

    if (filter === undefined) {
      return base(error, ctx.req)
    }

    try {
      const response = filter.handle(error, ctx)

      return isThenable(response) ? Promise.resolve(response).catch((failure: unknown) => base(failure, ctx.req)) : response
    } catch (failure) {
      return base(failure, ctx.req)
    }
  }

  const handler: Handler = (req, params, server) => {
    const ctx = new Context(req, params, route, server)

    try {
      const gate = hasGuards ? runGuards(guards, ctx, 0) : undefined
      const result = gate === undefined ? run(ctx) : gate.then(() => run(ctx))

      if (isThenable(result)) {
        return Promise.resolve(result)
          .then((value) => respond(value, ctx))
          .catch((error: unknown) => fail(error, ctx))
      }

      return respond(result, ctx)
    } catch (error) {
      return fail(error, ctx)
    }
  }

  // Shows up in stack traces and profiles, as in Nest.
  Object.defineProperty(handler, 'name', { value: `${route.controller.name}.${route.handler}` })

  return handler
}
