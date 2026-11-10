/**
 * @module
 * Lifecycle hooks.
 *
 * Like Nest and Angular, hooks run for every singleton that implements them:
 * classes, factory results, `useValue` objects, module classes, controllers,
 * each value once even if several providers share it. Transient instances
 * created during startup get them too; those created later by
 * `container.get()` belong to the caller.
 *
 * Hooks run one after another, in creation order (dependencies first) for
 * `onInit` and in reverse for `onDestroy`. Nest runs a dependency level in
 * parallel; sequential order is slower only when several hooks wait on I/O,
 * and keeps startup and shutdown deterministic.
 */

/**
 * Called once every singleton exists, dependencies first. `createContainer` waits for it.
 */
export interface OnInit {
  onInit(): void | Promise<void>
}

/**
 * Called by `container.close()`, in reverse creation order: dependents before their dependencies.
 * Also called if startup fails, for everything created so far.
 */
export interface OnDestroy {
  onDestroy(): void | Promise<void>
}

export const hasOnInit = (value: unknown): value is OnInit =>
  typeof value === 'object' && value !== null && typeof (value as Partial<OnInit>).onInit === 'function'

export const hasOnDestroy = (value: unknown): value is OnDestroy =>
  typeof value === 'object' && value !== null && typeof (value as Partial<OnDestroy>).onDestroy === 'function'

/**
 * Calls `onInit` in creation order, once per value. Stops at the first failure.
 */
export const initializeAll = async (created: readonly unknown[]): Promise<void> => {
  const done = new Set<unknown>()

  for (const value of created) {
    if (hasOnInit(value) && !done.has(value)) {
      done.add(value)
      await value.onInit()
    }
  }
}

/**
 * Calls `onDestroy` in reverse creation order, once per value. Every hook runs;
 * one failure is rethrown as is, several as an `AggregateError`.
 */
export const destroyAll = async (created: readonly unknown[]): Promise<void> => {
  const errors: unknown[] = []
  const done = new Set<unknown>()

  for (let i = created.length - 1; i >= 0; i--) {
    const value = created[i]

    if (done.has(value) || !hasOnDestroy(value)) {
      continue
    }

    done.add(value)

    try {
      await value.onDestroy()
    } catch (error) {
      errors.push(error)
    }
  }

  if (errors.length === 1) {
    throw errors[0]
  }

  if (errors.length > 1) {
    throw new AggregateError(errors, `${errors.length} onDestroy hooks failed`)
  }
}
