/**
 * @module
 * `@Module` and `@Injectable` class decorators (standard TC39 decorators).
 *
 * Metadata lives in WeakMaps keyed by class: no `reflect-metadata`, no
 * `Symbol.metadata` polyfill, nothing written onto user classes.
 */

import type { Provider, Scope } from './provider.ts'
import type { Constructor, Token } from './token.ts'

/**
 * Class decorated with `@Module`.
 */
export type ModuleClass = Constructor<unknown>

/**
 * Module created at runtime, usually by a static `forRoot()`:
 *
 * ```ts
 * @Module({ exports: [CONFIG] })
 * class ConfigModule {
 *   static forRoot(config: Config): DynamicModule {
 *     return { module: ConfigModule, providers: [provide(CONFIG, { useValue: config })] }
 *   }
 * }
 * ```
 *
 * Its fields are added to those of the `@Module` decorator of `module`.
 * Each dynamic module object is a separate module; importing the same object twice is one module.
 */
export interface DynamicModule extends ModuleDefinition {
  readonly module: ModuleClass
}

/**
 * What `imports` accepts. A promise lets a module load its configuration
 * asynchronously: `createContainer` waits for it while building the graph.
 */
export type ModuleImport = ModuleClass | DynamicModule | Promise<DynamicModule>

/**
 * Definition passed to `@Module`.
 */
export interface ModuleDefinition {
  /** Modules whose exports become visible to this module. */
  readonly imports?: readonly ModuleImport[]
  /** Providers owned by this module, private unless exported. */
  readonly providers?: readonly Provider[]
  /** Controllers owned by this module, created as private singletons. */
  readonly controllers?: readonly Constructor<unknown>[]
  /** Own or imported tokens to share, or imported modules to re-export entirely. */
  readonly exports?: readonly (Token<unknown> | ModuleClass)[]
  /** Makes the exports visible in every module without importing this one. */
  readonly global?: boolean
}

/**
 * Options of `@Injectable`.
 */
export interface InjectableOptions {
  /** Default scope of the class, overridden by `provide(X, { useClass: X, scope })`. */
  readonly scope?: Scope
}

const modules = new WeakMap<ModuleClass, ModuleDefinition>()
const injectables = new WeakMap<Constructor<unknown>, InjectableOptions>()

/**
 * Declares a module.
 *
 * ```ts
 * @Module({ imports: [DatabaseModule], providers: [UsersService], controllers: [UsersController], exports: [UsersService] })
 * class UsersModule {}
 * ```
 */
export const Module =
  (definition: ModuleDefinition) =>
  (target: ModuleClass, _context: ClassDecoratorContext<ModuleClass>): void => {
    modules.set(target, Object.freeze({ ...definition }))
  }

/**
 * Sets container options of a class. Optional: any class without
 * constructor arguments can be a provider.
 *
 * ```ts
 * @Injectable({ scope: 'transient' })
 * class RequestTimer {}
 * ```
 */
export const Injectable =
  (options: InjectableOptions = {}) =>
  (target: Constructor<unknown>, _context: ClassDecoratorContext<Constructor<unknown>>): void => {
    injectables.set(target, Object.freeze({ ...options }))
  }

/**
 * Definition of a `@Module` class, `undefined` if the class is not a module.
 *
 * Not inherited: a subclass of a module is a module only if decorated itself,
 * otherwise it would silently share its parent's providers and exports.
 */
export const getModuleDefinition = (target: unknown): ModuleDefinition | undefined =>
  typeof target === 'function' ? modules.get(target as ModuleClass) : undefined

/**
 * Options of an `@Injectable` class, inherited from the closest decorated ancestor.
 *
 * ```ts
 * @Injectable({ scope: 'transient' }) class Base {}
 * class Derived extends Base {} // transient too
 * ```
 */
export const getInjectableOptions = (target: Constructor<unknown>): InjectableOptions | undefined => {
  // The prototype of a class is its parent class; the chain ends at Function.prototype.
  for (
    let current: unknown = target;
    typeof current === 'function' && current !== Function.prototype;
    current = Object.getPrototypeOf(current)
  ) {
    const options = injectables.get(current as Constructor<unknown>)

    if (options !== undefined) {
      return options
    }
  }

  return undefined
}
