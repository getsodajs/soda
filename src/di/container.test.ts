import { describe, expect, it } from 'bun:test'
import { createContainer } from './container.ts'
import { inject } from './context.ts'
import { Injectable, Module } from './decorators.ts'
import type { DynamicModule } from './decorators.ts'
import type { OnDestroy, OnInit } from './lifecycle.ts'
import { optional, provide } from './provider.ts'
import { expectDiError } from './testing.ts'
import { InjectionToken } from './token.ts'

describe('injection', () => {
  it('injects into fields, private fields and the constructor', async () => {
    class Database {}
    class Repository {
      readonly db = inject(Database)
      readonly #db = inject(Database)
      readonly fromConstructor: Database
      constructor() {
        this.fromConstructor = inject(Database)
      }
      get privateDb(): Database {
        return this.#db
      }
    }
    @Module({ providers: [Database, Repository] })
    class AppModule {}

    const container = await createContainer(AppModule)
    const repository = container.get(Repository)
    const db = container.get(Database)

    expect([repository.db, repository.privateDb, repository.fromConstructor]).toEqual([db, db, db])
  })

  it('creates a singleton once and a transient for every injection', async () => {
    let created = 0

    @Injectable({ scope: 'transient' })
    class Timer {
      readonly id = ++created
    }
    class A {
      readonly timer = inject(Timer)
    }
    class B {
      readonly timer = inject(Timer)
    }
    @Module({ providers: [Timer, A, B] })
    class AppModule {}

    const container = await createContainer(AppModule)

    expect(container.get(A)).toBe(container.get(A))
    expect(container.get(A).timer).not.toBe(container.get(B).timer)
    expect(container.get(Timer)).not.toBe(container.get(Timer))
  })

  it('inherits @Injectable options and lets provide() override them', async () => {
    @Injectable({ scope: 'transient' })
    class Base {}
    class Derived extends Base {}
    class Pinned extends Base {}
    @Module({ providers: [Derived, provide(Pinned, { useClass: Pinned, scope: 'singleton' })] })
    class AppModule {}

    const container = await createContainer(AppModule)

    expect(container.get(Derived)).not.toBe(container.get(Derived))
    expect(container.get(Pinned)).toBe(container.get(Pinned))
  })

  it('supports values, classes, aliases and factories', async () => {
    interface Config {
      readonly url: string
    }
    const CONFIG = new InjectionToken<Config>('CONFIG')

    abstract class Logger {
      abstract log(message: string): string
    }
    class ConsoleLogger extends Logger {
      log(message: string): string {
        return `console: ${message}`
      }
    }
    const LOGGER_ALIAS = new InjectionToken<Logger>('LOGGER_ALIAS')
    const URL = new InjectionToken<string>('URL')
    const MISSING = new InjectionToken<string>('MISSING')

    @Module({
      providers: [
        provide(CONFIG, { useValue: { url: 'db://' } }),
        provide(Logger, { useClass: ConsoleLogger }),
        provide(LOGGER_ALIAS, { useExisting: Logger }),
        provide(URL, {
          inject: [CONFIG, LOGGER_ALIAS, optional(MISSING)],
          useFactory: (config, logger, missing) => logger.log(`${config.url}${missing ?? ''}`),
        }),
      ],
    })
    class AppModule {}

    const container = await createContainer(AppModule)

    expect(container.get(LOGGER_ALIAS)).toBe(container.get(Logger))
    expect(container.get(URL)).toBe('console: db://')
    expect(container.get(MISSING, { optional: true })).toBeUndefined()
  })

  it('gives a new instance through an alias of a transient provider', async () => {
    @Injectable({ scope: 'transient' })
    class Timer {}
    const ALIAS = new InjectionToken<Timer>('ALIAS')

    @Module({ providers: [Timer, provide(ALIAS, { useExisting: Timer })] })
    class AppModule {}

    const container = await createContainer(AppModule)

    expect(container.get(ALIAS)).not.toBe(container.get(ALIAS))
  })

  it('resolves optional dependencies to undefined', async () => {
    class Missing {}
    class Service {
      readonly missing = inject(Missing, { optional: true })
    }
    @Module({ providers: [Service] })
    class AppModule {}

    expect((await createContainer(AppModule)).get(Service).missing).toBeUndefined()
  })

  it('refuses inject() outside of an injection context, and inside factories', async () => {
    class Database {}
    await expectDiError(() => inject(Database), 'OUTSIDE_INJECTION_CONTEXT', /outside of an injection context/)

    const TOKEN = new InjectionToken<Database>('TOKEN')

    @Module({ providers: [Database, provide(TOKEN, { useFactory: () => inject(Database) })] })
    class AppModule {}
    await expectDiError(() => createContainer(AppModule), 'OUTSIDE_INJECTION_CONTEXT', /factories receive their dependencies/)
  })

  it('runs functions in an injection context with runInContext()', async () => {
    class Database {}
    @Module({ providers: [Database] })
    class AppModule {}

    const container = await createContainer(AppModule)

    expect(container.runInContext(() => inject(Database))).toBe(container.get(Database))
  })
})

describe('async factories', () => {
  it('awaits async factories, their async dependencies first, before creating classes', async () => {
    const order: string[] = []
    const CONFIG = new InjectionToken<string>('CONFIG')
    const CONNECTION = new InjectionToken<string>('CONNECTION')

    class Repository {
      readonly connection = inject(CONNECTION)
      constructor() {
        order.push('repository')
      }
    }
    @Module({
      providers: [
        Repository,
        provide(CONNECTION, {
          inject: [CONFIG],
          useFactory: async (config) => {
            await Bun.sleep(1)
            order.push('connection')

            return `connected to ${config}`
          },
        }),
        provide(CONFIG, {
          useFactory: async () => {
            await Bun.sleep(1)
            order.push('config')

            return 'db'
          },
        }),
      ],
    })
    class AppModule {}

    const container = await createContainer(AppModule)

    expect(container.get(Repository).connection).toBe('connected to db')
    expect(order).toEqual(['config', 'connection', 'repository'])
  })

  it('reports a class that needs an async provider before it is ready', async () => {
    const SLOW = new InjectionToken<string>('SLOW')
    const FIRST = new InjectionToken<string>('FIRST')

    class Bridge {
      readonly slow = inject(SLOW)
    }
    @Module({
      providers: [
        Bridge,
        provide(FIRST, { inject: [Bridge], useFactory: (bridge) => bridge.slow }),
        provide(SLOW, { useFactory: async () => 'slow' }),
      ],
    })
    class AppModule {}

    await expectDiError(
      () => createContainer(AppModule),
      'ASYNC_DEPENDENCY',
      /FIRST\) → Bridge → InjectionToken\(SLOW\).*List it in the `inject`/
    )
  })

  it('rejects an async transient factory', async () => {
    const TOKEN = new InjectionToken<number>('TOKEN')

    class Service {
      readonly value = inject(TOKEN)
    }
    @Module({ providers: [Service, provide(TOKEN, { scope: 'transient', useFactory: async () => 1 })] })
    class AppModule {}

    await expectDiError(() => createContainer(AppModule), 'INVALID_PROVIDER', /only singleton factories can be async/)
  })
})

describe('errors in the dependency graph', () => {
  it('reports a cycle with the full chain', async () => {
    class A {
      readonly b: unknown = inject(B)
    }
    class B {
      readonly c: unknown = inject(C)
    }
    class C {
      readonly a: unknown = inject(A)
    }
    @Module({ providers: [A, B, C] })
    class AppModule {}

    await expectDiError(() => createContainer(AppModule), 'CIRCULAR_DEPENDENCY', /Circular dependency: A → B → C → A$/)
  })

  it('reports a provider injecting its own token', async () => {
    class Logger {
      readonly inner: unknown = inject(Logger)
    }
    @Module({ providers: [Logger] })
    class AppModule {}

    await expectDiError(() => createContainer(AppModule), 'CIRCULAR_DEPENDENCY', /Logger injects its own token/)
  })

  it('reports circular aliases', async () => {
    const A = new InjectionToken<number>('A')
    const B = new InjectionToken<number>('B')

    @Module({ providers: [provide(A, { useExisting: B }), provide(B, { useExisting: A })] })
    class AppModule {}

    await expectDiError(() => createContainer(AppModule), 'CIRCULAR_DEPENDENCY', /InjectionToken\(A\) → InjectionToken\(B\) → InjectionToken\(A\)/)
  })

  it('does not leave a failed provider in a broken state', async () => {
    let attempts = 0

    @Injectable({ scope: 'transient' })
    class Flaky {
      constructor() {
        if (++attempts === 1) {
          throw new Error('first attempt fails')
        }
      }
    }
    @Module({ providers: [Flaky] })
    class AppModule {}

    const container = await createContainer(AppModule)

    expect(() => container.get(Flaky)).toThrow('first attempt fails')
    expect(container.get(Flaky)).toBeInstanceOf(Flaky)
  })

  it('rethrows an error from a constructor as is', async () => {
    const failure = new Error('cannot connect')

    class Database {
      constructor() {
        throw failure
      }
    }
    @Module({ providers: [Database] })
    class AppModule {}

    await expect(createContainer(AppModule)).rejects.toBe(failure)
  })
})

describe('modules', () => {
  class Database {}

  it('hides providers that are not exported, and says so', async () => {
    @Module({ providers: [Database] })
    class DatabaseModule {}
    class Users {
      readonly db = inject(Database)
    }
    @Module({ imports: [DatabaseModule], providers: [Users] })
    class AppModule {}

    await expectDiError(
      () => createContainer(AppModule),
      'NO_PROVIDER',
      /No provider for Database in AppModule \(Users → Database\)\. DatabaseModule provides it but does not export it\./
    )
  })

  it('tells which module to import when the provider is exported elsewhere', async () => {
    @Module({ providers: [Database], exports: [Database] })
    class DatabaseModule {}
    class Users {
      readonly db = inject(Database)
    }
    @Module({ providers: [Users] })
    class UsersModule {}
    @Module({ imports: [DatabaseModule, UsersModule] })
    class AppModule {}

    await expectDiError(
      () => createContainer(AppModule),
      'NO_PROVIDER',
      /in UsersModule .* DatabaseModule exports it: add DatabaseModule to the imports of UsersModule\./
    )
  })

  it('shares exported singletons, re-exports tokens and whole modules', async () => {
    class Cache {}
    @Module({ providers: [Database, Cache], exports: [Database, Cache] })
    class CoreModule {}
    @Module({ imports: [CoreModule], exports: [Database] })
    class TokenReexport {}
    @Module({ imports: [CoreModule], exports: [CoreModule] })
    class ModuleReexport {}
    class A {
      readonly db = inject(Database)
    }
    class B {
      readonly db = inject(Database)
      readonly cache = inject(Cache)
    }
    @Module({ imports: [TokenReexport], providers: [A], exports: [A] })
    class FeatureA {}
    @Module({ imports: [ModuleReexport], providers: [B], exports: [B] })
    class FeatureB {}
    @Module({ imports: [FeatureA, FeatureB] })
    class AppModule {}

    const container = await createContainer(AppModule)
    const a = container.get(A)
    const b = container.get(B)

    expect(a.db).toBe(b.db)
    expect(b.cache).toBeInstanceOf(Cache)
    expect(container.get(Database, { from: FeatureB })).toBe(a.db)
  })

  it('handles modules importing each other through dynamic modules', async () => {
    // A static cycle cannot be declared: a class is undefined inside its own decorator's
    // arguments. Dynamic module objects can form one; the graph must still terminate.
    class Left {}
    class Right {
      readonly left = inject(Left)
    }
    @Module({})
    class LeftModule {}
    @Module({})
    class RightModule {}
    // Each module re-exports the other: a lookup must not loop forever.
    const leftImports: DynamicModule[] = []
    const left: DynamicModule = {
      module: LeftModule,
      imports: leftImports,
      providers: [Left],
      exports: [Left, RightModule],
    }
    const right: DynamicModule = {
      module: RightModule,
      imports: [left],
      providers: [Right],
      exports: [Right, LeftModule],
    }

    leftImports.push(right)
    @Module({ imports: [right] })
    class AppModule {}

    const container = await createContainer(AppModule)
    const MISSING = new InjectionToken<string>('MISSING')

    expect(container.get(Right).left).toBe(container.get(Left))
    expect(container.get(MISSING, { optional: true })).toBeUndefined()
  })

  it('makes exports of global modules visible everywhere, below explicit imports', async () => {
    const SETTING = new InjectionToken<string>('SETTING')

    @Module({ providers: [provide(SETTING, { useValue: 'global' })], exports: [SETTING], global: true })
    class GlobalConfig {}
    @Module({ providers: [provide(SETTING, { useValue: 'feature' })], exports: [SETTING] })
    class FeatureConfig {}
    class ReadsGlobal {
      readonly setting = inject(SETTING)
    }
    class ReadsFeature {
      readonly setting = inject(SETTING)
    }
    @Module({ providers: [ReadsGlobal], exports: [ReadsGlobal] })
    class PlainModule {}
    @Module({ imports: [FeatureConfig], providers: [ReadsFeature], exports: [ReadsFeature] })
    class FeatureModule {}
    @Module({ imports: [GlobalConfig, PlainModule, FeatureModule] })
    class AppModule {}

    const container = await createContainer(AppModule)

    expect(container.get(ReadsGlobal).setting).toBe('global')
    expect(container.get(ReadsFeature).setting).toBe('feature')
  })

  it('lets own providers shadow imported ones', async () => {
    const NAME = new InjectionToken<string>('NAME')

    @Module({ providers: [provide(NAME, { useValue: 'imported' })], exports: [NAME] })
    class Shared {}
    @Module({ imports: [Shared], providers: [provide(NAME, { useValue: 'own' })] })
    class AppModule {}

    expect((await createContainer(AppModule)).get(NAME)).toBe('own')
  })

  it('refuses a token exported by two imports with different providers', async () => {
    const NAME = new InjectionToken<string>('NAME')

    @Module({ providers: [provide(NAME, { useValue: 'one' })], exports: [NAME] })
    class One {}
    @Module({ providers: [provide(NAME, { useValue: 'two' })], exports: [NAME] })
    class Two {}
    class Reader {
      readonly name = inject(NAME)
    }
    @Module({ imports: [One, Two], providers: [Reader] })
    class AppModule {}

    await expectDiError(() => createContainer(AppModule), 'AMBIGUOUS_PROVIDER', /exported to AppModule by several imports .*One, Two/)
  })

  it('accepts the same provider reaching a module through two imports', async () => {
    @Module({ providers: [Database], exports: [Database] })
    class Core {}
    @Module({ imports: [Core], exports: [Core] })
    class Left {}
    @Module({ imports: [Core], exports: [Core] })
    class Right {}
    @Module({ imports: [Left, Right] })
    class AppModule {}

    expect((await createContainer(AppModule)).get(Database)).toBeInstanceOf(Database)
  })

  it('validates module definitions', async () => {
    class NotAModule {}
    @Module({ imports: [NotAModule as never] })
    class ImportsClass {}
    await expectDiError(() => createContainer(ImportsClass), 'INVALID_MODULE', /ImportsClass imports NotAModule, which is not a @Module class/)

    @Module({ imports: [undefined as never] })
    class ImportsUndefined {}
    await expectDiError(() => createContainer(ImportsUndefined), 'INVALID_MODULE', /imports\[0\] of ImportsUndefined is undefined: usually a circular file import/)

    @Module({ providers: [Database, Database] })
    class Duplicate {}
    await expectDiError(() => createContainer(Duplicate), 'DUPLICATE_PROVIDER', /Duplicate provides Database more than once/)

    @Module({})
    class Child {}
    @Module({ providers: [Child] })
    class ModuleAsProvider {}
    await expectDiError(() => createContainer(ModuleAsProvider), 'INVALID_PROVIDER', /Child is a module: list it in imports/)

    @Module({ exports: [Database] })
    class ExportsUnknown {}
    await expectDiError(() => createContainer(ExportsUnknown), 'INVALID_EXPORT', /exports Database, which it neither provides nor imports/)

    @Module({ exports: [Child] })
    class ExportsUnimported {}
    await expectDiError(() => createContainer(ExportsUnimported), 'INVALID_EXPORT', /exports module Child without importing it/)

    class NeedsArguments {
      constructor(readonly value: string) {}
    }
    @Module({ providers: [NeedsArguments as never] })
    class ConstructorArguments {}
    await expectDiError(() => createContainer(ConstructorArguments), 'INVALID_PROVIDER', /declares 1 constructor parameter/)
  })

  it('creates a separate module per dynamic module object, and one per object', async () => {
    const PREFIX = new InjectionToken<string>('PREFIX')

    class Formatter {
      readonly prefix = inject(PREFIX)
    }
    @Module({ providers: [Formatter], exports: [Formatter] })
    class FormatModule {
      static forRoot(prefix: string): DynamicModule {
        return { module: FormatModule, providers: [provide(PREFIX, { useValue: prefix })] }
      }
    }
    const shared = FormatModule.forRoot('shared')

    class A {
      readonly formatter = inject(Formatter)
    }
    class B {
      readonly formatter = inject(Formatter)
    }
    @Module({ imports: [shared], providers: [A], exports: [A] })
    class FeatureA {}
    @Module({ imports: [shared], providers: [B], exports: [B] })
    class FeatureB {}
    class C {
      readonly formatter = inject(Formatter)
    }
    @Module({ imports: [FormatModule.forRoot('own')], providers: [C], exports: [C] })
    class FeatureC {}
    @Module({ imports: [FeatureA, FeatureB, FeatureC] })
    class AppModule {}

    const container = await createContainer(AppModule)

    expect(container.get(A).formatter).toBe(container.get(B).formatter)
    expect(container.get(C).formatter.prefix).toBe('own')
    await expectDiError(() => container.get(Formatter, { from: FormatModule }), 'INVALID_MODULE', /several times as different dynamic modules/)
  })

  it('awaits Promise<DynamicModule> imports', async () => {
    const SETTING = new InjectionToken<string>('SETTING')

    @Module({})
    class ConfigModule {
      static async load(): Promise<DynamicModule> {
        await Bun.sleep(1)

        return { module: ConfigModule, providers: [provide(SETTING, { useValue: 'loaded' })], exports: [SETTING] }
      }
    }
    @Module({ imports: [ConfigModule.load()] })
    class AppModule {}

    expect((await createContainer(AppModule)).get(SETTING)).toBe('loaded')
  })

  it('creates controllers, which are not injectable', async () => {
    class UsersController {
      readonly db = inject(Database)
    }
    class Spy {
      readonly controller = inject(UsersController)
    }
    @Module({ providers: [Database], controllers: [UsersController] })
    class UsersModule {}
    @Module({ imports: [UsersModule] })
    class AppModule {}

    const container = await createContainer(AppModule)

    expect(container.controllers).toHaveLength(1)
    expect(container.controllers[0]).toMatchObject({ module: UsersModule, controller: UsersController })
    expect(container.controllers[0]!.instance).toBeInstanceOf(UsersController)

    @Module({ providers: [Spy], controllers: [UsersController] })
    class Injecting {}
    await expectDiError(() => createContainer(Injecting), 'NO_PROVIDER', /No provider for UsersController/)
  })

  it('replaces providers everywhere with overrides, and refuses unused overrides', async () => {
    class Real {}
    class Fake {}
    @Module({ providers: [Real], exports: [Real] })
    class Inner {}
    @Module({ imports: [Inner] })
    class AppModule {}

    const container = await createContainer(AppModule, { overrides: [provide(Real, { useClass: Fake })] })

    expect(container.get(Real)).toBeInstanceOf(Fake)

    await expectDiError(
      () => createContainer(AppModule, { overrides: [provide(Database, { useValue: {} })] }),
      'INVALID_PROVIDER',
      /Override for Database matches no provider/
    )
  })
})

describe('lifecycle', () => {
  it('runs onInit dependencies first and onDestroy in reverse, on every singleton once', async () => {
    const log: string[] = []
    const hooks = (name: string): OnInit & OnDestroy => ({
      onInit: async () => {
        await Bun.sleep(1)
        log.push(`init ${name}`)
      },
      onDestroy: () => {
        log.push(`destroy ${name}`)
      },
    })
    const VALUE = new InjectionToken<object>('VALUE')
    const ALIAS = new InjectionToken<object>('ALIAS')

    class Database implements OnInit, OnDestroy {
      readonly hooks = hooks('database')
      onInit = (): Promise<void> => this.hooks.onInit() as Promise<void>
      onDestroy = (): void => this.hooks.onDestroy() as void
    }
    class Users implements OnInit, OnDestroy {
      readonly db = inject(Database)
      readonly value = inject(VALUE)
      readonly hooks = hooks('users')
      onInit = (): Promise<void> => this.hooks.onInit() as Promise<void>
      onDestroy = (): void => this.hooks.onDestroy() as void
    }
    @Module({ providers: [Users, Database, provide(VALUE, { useValue: hooks('value') }), provide(ALIAS, { useExisting: VALUE })] })
    class AppModule implements OnInit {
      onInit(): void {
        log.push('init module')
      }
    }

    const container = await createContainer(AppModule)

    expect(log).toEqual(['init database', 'init value', 'init users', 'init module'])
    log.length = 0
    await container.close()
    expect(log).toEqual(['destroy users', 'destroy value', 'destroy database'])
  })

  it('runs hooks of transient instances created at startup', async () => {
    const log: string[] = []

    @Injectable({ scope: 'transient' })
    class Timer implements OnInit {
      onInit(): void {
        log.push('timer')
      }
    }
    class A {
      readonly timer = inject(Timer)
    }
    @Module({ providers: [Timer, A] })
    class AppModule {}

    const container = await createContainer(AppModule)

    container.get(Timer)
    expect(log).toEqual(['timer'])
  })

  it('returns the same promise from close(), even when a hook calls close()', async () => {
    let destroyed = 0
    let reentrant: Promise<void> | undefined
    let container: Awaited<ReturnType<typeof createContainer>> | undefined

    class Service implements OnDestroy {
      onDestroy(): void {
        destroyed++
        reentrant = container!.close()
      }
    }
    @Module({ providers: [Service] })
    class AppModule {}

    container = await createContainer(AppModule)
    const closing = container.close()

    await closing
    expect(destroyed).toBe(1)
    expect(reentrant).toBe(closing)
    expect(container.close()).toBe(closing)
    await expectDiError(() => container.get(Service), 'CONTAINER_CLOSED', /the container is closed/)
  })

  it('runs every onDestroy hook even if some fail', async () => {
    const log: string[] = []

    class A implements OnDestroy {
      onDestroy(): void {
        log.push('a')

        throw new Error('a failed')
      }
    }
    class B implements OnDestroy {
      readonly a = inject(A)
      onDestroy(): void {
        log.push('b')

        throw new Error('b failed')
      }
    }
    @Module({ providers: [A, B] })
    class AppModule {}

    const container = await createContainer(AppModule)
    const error = await container.close().catch((caught: unknown) => caught)

    expect(log).toEqual(['b', 'a'])
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors.map((e: Error) => e.message)).toEqual(['b failed', 'a failed'])
  })

  it('destroys what was created when startup fails', async () => {
    const log: string[] = []

    class Database implements OnDestroy {
      onDestroy(): void {
        log.push('database destroyed')
      }
    }
    class Users implements OnInit {
      readonly db = inject(Database)
      onInit(): void {
        throw new Error('init failed')
      }
    }
    @Module({ providers: [Database, Users] })
    class AppModule {}

    await expect(createContainer(AppModule)).rejects.toThrow('init failed')
    expect(log).toEqual(['database destroyed'])
  })

  it('reports startup and rollback failures together', async () => {
    class Database implements OnDestroy {
      onDestroy(): void {
        throw new Error('destroy failed')
      }
    }
    class Users implements OnInit {
      readonly db = inject(Database)
      onInit(): void {
        throw new Error('init failed')
      }
    }
    @Module({ providers: [Database, Users] })
    class AppModule {}

    const error = await createContainer(AppModule).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors.map((e: Error) => e.message)).toEqual(['init failed', 'destroy failed'])
  })

  it('destroys the result of an async factory that was still running when startup failed', async () => {
    const log: string[] = []
    const CONNECTION = new InjectionToken<OnDestroy>('CONNECTION')
    const FIRST = new InjectionToken<unknown>('FIRST')

    class Bridge {
      readonly connection = inject(CONNECTION)
    }
    @Module({
      providers: [
        Bridge,
        // Needs Bridge, which needs CONNECTION before its turn: startup fails while it runs.
        provide(FIRST, { inject: [Bridge], useFactory: (bridge) => bridge }),
        provide(CONNECTION, {
          useFactory: async () => {
            await Bun.sleep(5)

            return { onDestroy: () => void log.push('connection closed') }
          },
        }),
      ],
    })
    class AppModule {}

    await expectDiError(() => createContainer(AppModule), 'ASYNC_DEPENDENCY', /CONNECTION/)
    expect(log).toEqual(['connection closed'])
  })
})
