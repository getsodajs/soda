/**
 * @module
 * `Discovery`: the providers of the application, for modules that find them by
 * their class, as Nest's `DiscoveryService` does (CQRS handlers).
 *
 * ```ts
 * const handlers = inject(Discovery).providers().filter((provider) => isHandler(provider.token))
 * ```
 */

import type { ModuleClass } from './decorators.ts'
import type { Token } from './token.ts'

/** A provider of a module, as `Discovery` lists it. */
export interface DiscoveredProvider {
  readonly token: Token<unknown>
  /** The module listing it. */
  readonly module: ModuleClass
  /** Its value: the singleton, created at startup; a new instance for a transient provider. */
  get(): unknown
}

const sources = new WeakMap<Discovery, () => readonly DiscoveredProvider[]>()

/**
 * The providers of every module, those the application adds itself (its `Logger`) left out:
 * `inject(Discovery)`. Read it once the application has started, from a method or `onInit`,
 * not while providers are being created.
 */
export class Discovery {
  /** In module order, imports before importers. */
  providers(): readonly DiscoveredProvider[] {
    return sources.get(this)?.() ?? []
  }
}

/** Gives `discovery` its providers, once the container that holds it exists. */
export const attachDiscovery = (discovery: Discovery, source: () => readonly DiscoveredProvider[]): void => {
  sources.set(discovery, source)
}
