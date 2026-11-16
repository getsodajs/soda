/**
 * @module
 * The dry run of the container, for `soda check`: the graph is resolved
 * without side effects, and every problem is reported instead of the first.
 *
 * - Classes are created: their `inject()` calls are what tells their dependencies.
 * - Factories are not called (they open connections), only their `inject` is
 *   resolved; they give a stub. Factories marked with `safeToCheck()`, such as
 *   those loading configurations, are called.
 * - A missing provider, a cycle, a class failing gives a stub, and the check goes on.
 * - No `onInit`, no `onDestroy`.
 */

/** What the dry run calls instead of throwing. */
export type ReportProblem = (error: unknown) => void

const safe = new WeakSet<object>()

/**
 * Marks a factory as free of side effects: the dry run calls it, to check its result.
 * ConfigModule's factories are: an invalid configuration is found by `soda check`.
 */
export const safeToCheck = <F extends (...args: never[]) => unknown>(factory: F): F => {
  safe.add(factory)

  return factory
}

export const isSafeToCheck = (factory: object): boolean => safe.has(factory)

const stubTarget = function stub(): void {}

/**
 * Stands for a value the dry run does not create: any property, call or
 * `new` gives the stub again; it is not a promise, iterates as empty, and
 * converts to an empty string.
 */
export const STUB: unknown = new Proxy(stubTarget, {
  get(_target, key) {
    if (key === 'then') {
      return undefined
    }

    if (key === Symbol.toPrimitive) {
      return () => ''
    }

    if (key === Symbol.iterator) {
      return function* empty(): Generator<never> {}
    }

    return STUB
  },
  apply: () => STUB,
  construct: () => STUB as object,
})

/** A dependency a provider asked for in a dry run. */
export interface DescribedDependency {
  readonly token: string
  readonly optional: boolean
  /** Module whose provider answered, `application` for what the application provides (its `Logger`); `undefined` when none did. */
  readonly from: string | undefined
}

export interface DescribedProvider {
  readonly token: string
  readonly kind: 'class' | 'value' | 'factory' | 'alias'
  readonly scope: 'singleton' | 'transient'
  /** What it injects, in the order it asked. */
  readonly injects: readonly DescribedDependency[]
}

/** A module as the dry run saw it, for `soda inspect`. */
export interface DescribedModule {
  readonly name: string
  readonly global: boolean
  readonly imports: readonly string[]
  /** Tokens, then re-exported modules. */
  readonly exports: readonly string[]
  readonly providers: readonly DescribedProvider[]
  readonly controllers: readonly DescribedProvider[]
}
