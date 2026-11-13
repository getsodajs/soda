/**
 * @module
 * Guards, interceptors, exception filters and custom metadata: what Nest calls enhancers.
 *
 * Each of them comes in three forms:
 *
 * - a class, created once per module by the container, so it can `inject()`
 *   what the controller's module sees (as Nest does);
 * - an instance, used as is;
 * - a function, run where `inject()` works (as Angular's functional guards).
 *
 * ```ts
 * @Controller('/admin')
 * @UseGuards(AuthGuard)                         // class: created by the container
 * @UseInterceptors(timing)                      // function
 * export class AdminController {
 *   @Delete(':id')
 *   @Roles(['admin'])                            // custom metadata, read by a guard
 *   @UseFilters(new DatabaseErrorFilter())       // instance
 *   remove(ctx: Context<':id'>) {}
 * }
 * ```
 *
 * Order, as in Nest: guards, then interceptors, then argument reading and the
 * handler; each kind global first, then class, then method. Exception filters
 * wrap all of it and are tried the other way round: method, class, global.
 */

import type { ClassToken, Constructor } from '../di/index.ts'
import { nameOf } from '../utils/name.ts'
import type { Context } from './context.ts'
import { ControllerError } from './errors.ts'

/** Class guard. Like Nest's `CanActivate`. */
export interface CanActivate {
  canActivate(ctx: Context): boolean | Promise<boolean>
}

/** Function guard; `inject()` works inside it. */
export type GuardFunction = (ctx: Context) => boolean | Promise<boolean>

/** What `@UseGuards()` accepts. Returning `false` answers `403 Forbidden resource`. */
export type Guard = Constructor<CanActivate> | CanActivate | GuardFunction

/** Continues the chain; resolves to the value the handler returned. */
export type CallHandler = () => Promise<unknown>

/**
 * Class interceptor. Like Nest's `NestInterceptor`, with a promise instead of an
 * Observable: work before `next()`, after it, instead of it (a cache), or map its result.
 */
export interface Interceptor {
  intercept(ctx: Context, next: CallHandler): unknown
}

/** Function interceptor; `inject()` works inside it, before the first `await`. */
export type InterceptorFunction = (ctx: Context, next: CallHandler) => unknown

/** What `@UseInterceptors()` accepts. */
export type InterceptorLike = Constructor<Interceptor> | Interceptor | InterceptorFunction

/** Class exception filter. Like Nest's `ExceptionFilter`, returning the response to send. */
export interface ExceptionFilter<E = unknown> {
  catch(error: E, ctx: Context): Response | Promise<Response>
}

/** Function exception filter, catching everything. */
export type FilterFunction = (error: unknown, ctx: Context) => Response | Promise<Response>

/** What `@UseFilters()` accepts. */
export type FilterLike = Constructor<ExceptionFilter> | ExceptionFilter | FilterFunction

/** Guards, interceptors and filters declared at one level (global, class or method). */
export interface Enhancers {
  readonly guards: readonly Guard[]
  readonly interceptors: readonly InterceptorLike[]
  readonly filters: readonly FilterLike[]
}

interface MutableEnhancers {
  guards: Guard[]
  interceptors: InterceptorLike[]
  filters: FilterLike[]
  readonly metadata: Map<symbol, unknown>
}

/**
 * Decorator usable on a controller class and on a route method.
 */
export type ClassOrMethodDecorator = (
  target: object,
  context: ClassDecoratorContext | ClassMethodDecoratorContext
) => void

/** Keyed by controller class or by method function. */
const declared = new WeakMap<object, MutableEnhancers>()
/** Exception types of `@Catch()`, keyed by filter class and by its prototype. */
const caught = new WeakMap<object, readonly ClassToken<unknown>[]>()

const enhancersOf = (target: object): MutableEnhancers => {
  let enhancers = declared.get(target)

  if (enhancers === undefined) {
    enhancers = { guards: [], interceptors: [], filters: [], metadata: new Map() }
    declared.set(target, enhancers)
  }

  return enhancers
}

const assertTarget = (decorator: string, context: ClassDecoratorContext | ClassMethodDecoratorContext): void => {
  if (context.kind === 'method' && (context.static || context.private)) {
    throw new ControllerError('INVALID_HANDLER', `@${decorator}() must decorate a controller class or a public instance method`)
  }
}

const assertCallable = <T>(decorator: string, values: readonly T[], method: string): void => {
  for (const value of values) {
    const valid =
      typeof value === 'function' || (typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>)[method] === 'function')

    if (!valid) {
      throw new ControllerError('INVALID_HANDLER', `@${decorator}() received ${nameOf(value)}, which has no ${method}()`)
    }
  }
}

/**
 * Adds guards to a controller or a route. Like Nest's `@UseGuards()`.
 */
export const UseGuards =
  (...guards: Guard[]): ClassOrMethodDecorator =>
  (target, context) => {
    assertTarget('UseGuards', context)
    assertCallable('UseGuards', guards, 'canActivate')
    // Decorators run bottom-up: prepend to keep the source order.
    enhancersOf(target).guards.unshift(...guards)
  }

/**
 * Adds interceptors to a controller or a route. Like Nest's `@UseInterceptors()`.
 */
export const UseInterceptors =
  (...interceptors: InterceptorLike[]): ClassOrMethodDecorator =>
  (target, context) => {
    assertTarget('UseInterceptors', context)
    assertCallable('UseInterceptors', interceptors, 'intercept')
    enhancersOf(target).interceptors.unshift(...interceptors)
  }

/**
 * Adds exception filters to a controller or a route. Like Nest's `@UseFilters()`.
 */
export const UseFilters =
  (...filters: FilterLike[]): ClassOrMethodDecorator =>
  (target, context) => {
    assertTarget('UseFilters', context)
    assertCallable('UseFilters', filters, 'catch')
    enhancersOf(target).filters.unshift(...filters)
  }

/**
 * Exceptions a filter class handles; without arguments, everything. Like Nest's `@Catch()`.
 * Recorded on the class and its prototype, as Nest does: a class decorator may
 * return a proxy of the class, and mixins overwrite `constructor`.
 */
export const Catch =
  (...exceptions: ClassToken<unknown>[]) =>
  (target: Constructor<ExceptionFilter>, _context: ClassDecoratorContext<Constructor<ExceptionFilter>>): void => {
    caught.set(target, exceptions)
    caught.set(target.prototype as object, exceptions)
  }

/**
 * A typed metadata key with its decorator. Like Nest's `Reflector.createDecorator()`.
 *
 * ```ts
 * export const Roles = createDecorator<readonly string[]>('Roles')
 *
 * @Roles(['admin'])              // on a class or a method; the method's value wins
 * remove() {}
 *
 * const roles = ctx.metadata(Roles) // readonly string[] | undefined, in a guard
 * ```
 */
export interface MetadataDecorator<T> {
  (value: T): ClassOrMethodDecorator
  readonly key: symbol
}

export const createDecorator = <T>(description: string): MetadataDecorator<T> => {
  const key = Symbol(description)

  const decorator = (value: T): ClassOrMethodDecorator => (target, context) => {
    assertTarget(description, context)
    enhancersOf(target).metadata.set(key, value)
  }

  return Object.assign(decorator, { key })
}

const NO_ENHANCERS: MutableEnhancers = { guards: [], interceptors: [], filters: [], metadata: new Map() }

/** Enhancers and metadata declared on a method function. */
export const getMethodEnhancers = (method: object): MutableEnhancers => declared.get(method) ?? NO_ENHANCERS

/**
 * Enhancers of a controller class, parents first: a subclass extends the guards
 * of its parent, as Nest's `extendArrayMetadata` does. For metadata, the closest
 * class wins.
 */
export const getClassEnhancers = (controller: Constructor<unknown>): MutableEnhancers => {
  const chain: MutableEnhancers[] = []

  for (
    let current: unknown = controller;
    typeof current === 'function' && current !== Function.prototype;
    current = Object.getPrototypeOf(current)
  ) {
    const enhancers = declared.get(current)

    if (enhancers !== undefined) {
      chain.unshift(enhancers)
    }
  }

  const merged: MutableEnhancers = { guards: [], interceptors: [], filters: [], metadata: new Map() }

  for (const enhancers of chain) {
    merged.guards.push(...enhancers.guards)
    merged.interceptors.push(...enhancers.interceptors)
    merged.filters.push(...enhancers.filters)

    for (const [key, value] of enhancers.metadata) {
      merged.metadata.set(key, value)
    }
  }

  return merged
}

/** Exception types a filter handles; empty for "everything". */
export const getCaughtExceptions = (filter: object): readonly ClassToken<unknown>[] =>
  caught.get(filter) ?? caught.get(Object.getPrototypeOf(filter) as object) ?? []
