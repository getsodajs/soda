/**
 * @module
 * Provider definitions.
 *
 * A module lists providers either as a class (`UsersService`) or with `provide()`:
 *
 * ```ts
 * providers: [
 *   UsersService,
 *   provide(CONFIG, { useValue: config }),
 *   provide(Logger, { useClass: ConsoleLogger }),
 *   provide(Cache, { useExisting: RedisCache }),
 *   provide(Database, { inject: [CONFIG, optional(Logger)], useFactory: (config, logger) => connect(config, logger) }),
 * ]
 * ```
 *
 * `provide()` checks every definition against the token type, which a plain
 * object in a heterogeneous array could not.
 */

import { DiError } from './errors'
import { describeInvalidToken, isToken, tokenName } from './token'
import type { Constructor, Token, TokenValue } from './token'

/**
 * Lifetime of a created value.
 *
 * - `singleton`: one instance per provider, created at startup.
 * - `transient`: a new instance for every injection.
 *
 * There is no request scope: request data travels in the request context,
 * which keeps the dependency graph static and free of per-request work.
 */
export type Scope = 'singleton' | 'transient'

const OPTIONAL = Symbol('optional')

/**
 * Optional dependency of a factory: resolves to `undefined` when no provider is visible.
 */
export interface OptionalDependency<T> {
  readonly [OPTIONAL]: true
  readonly token: Token<T>
}

/**
 * Marks a factory dependency as optional.
 *
 * ```ts
 * provide(Database, { inject: [optional(Logger)], useFactory: (logger) => connect(logger) })
 * // logger: Logger | undefined
 * ```
 */
export const optional = <T>(token: Token<T>): OptionalDependency<T> =>
  Object.freeze({ [OPTIONAL]: true as const, token })

export type Dependency = Token<unknown> | OptionalDependency<unknown>

/**
 * Values a factory receives for its `inject` list.
 */
export type DependencyValues<D extends readonly Dependency[]> = {
  readonly [K in keyof D]: D[K] extends OptionalDependency<infer T> ? T | undefined : TokenValue<D[K]>
}

export interface FactoryDependency {
  readonly token: Token<unknown>
  readonly optional: boolean
}

/**
 * Normalised provider, as used by the container.
 */
export type ProviderDefinition =
  | { readonly kind: 'class'; readonly useClass: Constructor<unknown>; readonly scope: Scope | undefined }
  | { readonly kind: 'value'; readonly value: unknown }
  | {
      readonly kind: 'factory'
      readonly useFactory: (...args: unknown[]) => unknown
      readonly dependencies: readonly FactoryDependency[]
      readonly scope: Scope
    }
  | { readonly kind: 'existing'; readonly target: Token<unknown> }

const PROVIDER = Symbol('provider')
const PROVIDER_KINDS = ['useValue', 'useClass', 'useExisting', 'useFactory'] as const

/**
 * Provider created by `provide()`.
 */
export interface ProviderRecord {
  readonly [PROVIDER]: true
  readonly token: Token<unknown>
  readonly definition: ProviderDefinition
}

/**
 * Entry of a module's `providers`.
 */
export type Provider = Constructor<unknown> | ProviderRecord

const isOptional = (dependency: Dependency): dependency is OptionalDependency<unknown> =>
  typeof dependency === 'object' && OPTIONAL in dependency

/** `true` for an object produced by `provide()`. */
export const isProviderRecord = (value: unknown): value is ProviderRecord =>
  typeof value === 'object' && value !== null && PROVIDER in value

const invalid = (token: Token<unknown>, reason: string): DiError =>
  new DiError('INVALID_PROVIDER', `Invalid provider for ${tokenName(token)}: ${reason}`)

/**
 * Checks that a class can be created by the container: no constructor
 * parameters, since dependencies come from `inject()`.
 */
export const assertConstructible = (token: Token<unknown>, useClass: unknown): Constructor<unknown> => {
  if (typeof useClass !== 'function') {
    throw invalid(token, `useClass is not a class: ${String(useClass)}`)
  }

  if (useClass.length > 0) {
    throw invalid(
      token,
      `${useClass.name} declares ${useClass.length} constructor parameter(s); ` +
        'the container creates classes without arguments, take dependencies with inject()'
    )
  }

  return useClass as Constructor<unknown>
}

/** Provides a value created outside the container. */
export function provide<T>(token: Token<T>, spec: { readonly useValue: T }): ProviderRecord
/** Provides an instance of `useClass`, which may differ from the token: `provide(Logger, { useClass: ConsoleLogger })`. */
export function provide<T>(
  token: Token<T>,
  spec: { readonly useClass: Constructor<T>; readonly scope?: Scope }
): ProviderRecord
/** Makes `token` an alias of another token: it injects whatever that token injects, transient included. */
export function provide<T>(token: Token<T>, spec: { readonly useExisting: Token<T> }): ProviderRecord
/**
 * Provides the result of `useFactory`, called with the values of `inject`.
 * A singleton factory may be async: `createContainer` waits for it.
 */
export function provide<T, const D extends readonly Dependency[] = []>(
  token: Token<T>,
  spec: {
    readonly inject?: D
    readonly useFactory: (...args: DependencyValues<D>) => T | Promise<T>
    readonly scope?: Scope
  }
): ProviderRecord
export function provide(token: Token<unknown>, spec: Readonly<Record<string, unknown>>): ProviderRecord {
  if (!isToken(token)) {
    throw new DiError('INVALID_PROVIDER', `provide() received a token that is ${describeInvalidToken(token)}`)
  }

  let kinds = 0

  for (let i = 0, len = PROVIDER_KINDS.length; i < len; i++) {
    if (PROVIDER_KINDS[i]! in spec) {
      kinds++
    }
  }

  if (kinds !== 1) {
    throw invalid(token, 'define exactly one of useValue, useClass, useExisting, useFactory')
  }

  const scope = spec.scope

  if (scope !== undefined) {
    if (scope !== 'singleton' && scope !== 'transient') {
      throw invalid(token, `unknown scope "${String(scope)}"`)
    }

    if (!('useClass' in spec) && !('useFactory' in spec)) {
      throw invalid(token, 'scope only applies to useClass and useFactory')
    }
  }

  let definition: ProviderDefinition

  if ('useValue' in spec) {
    definition = { kind: 'value', value: spec.useValue }
  } else if ('useClass' in spec) {
    definition = { kind: 'class', useClass: assertConstructible(token, spec.useClass), scope }
  } else if ('useExisting' in spec) {
    const target = spec.useExisting

    if (!isToken(target)) {
      throw invalid(token, `useExisting is ${describeInvalidToken(target)}`)
    }

    if (target === token) {
      throw invalid(token, 'a token cannot be an alias of itself')
    }

    definition = { kind: 'existing', target }
  } else {
    if (typeof spec.useFactory !== 'function') {
      throw invalid(token, 'useFactory is not a function')
    }

    const list = (spec.inject ?? []) as readonly unknown[]

    const dependencies: FactoryDependency[] = []

    for (let i = 0, len = list.length; i < len; i++) {
      const entry = list[i]
      const dependency = typeof entry === 'object' && entry !== null && isOptional(entry as Dependency)
        ? { token: (entry as OptionalDependency<unknown>).token, optional: true }
        : { token: entry as Token<unknown>, optional: false }

      if (!isToken(dependency.token)) {
        throw invalid(token, `inject[${i}] is ${describeInvalidToken(dependency.token)}`)
      }

      dependencies.push(dependency)
    }

    definition = {
      kind: 'factory',
      useFactory: spec.useFactory as (...args: unknown[]) => unknown,
      dependencies,
      scope: scope ?? 'singleton',
    }
  }

  return Object.freeze({ [PROVIDER]: true as const, token, definition })
}
