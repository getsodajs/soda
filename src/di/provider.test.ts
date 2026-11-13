import { describe, expect, it } from 'bun:test'
import { inject } from './context.ts'
import { optional, provide } from './provider.ts'
import { expectDiError } from './testing.ts'
import { InjectionToken } from './token.ts'

interface Config {
  readonly url: string
}
const CONFIG = new InjectionToken<Config>('CONFIG')

class Logger {
  log(_message: string): void {}
}
class ConsoleLogger extends Logger {}

describe('provide', () => {
  it('normalises every provider kind', () => {
    expect(provide(CONFIG, { useValue: { url: 'x' } }).definition).toEqual({ kind: 'value', value: { url: 'x' } })
    expect(provide(Logger, { useClass: ConsoleLogger, scope: 'transient' }).definition).toEqual({
      kind: 'class',
      useClass: ConsoleLogger,
      scope: 'transient',
    })
    expect(provide(Logger, { useExisting: ConsoleLogger }).definition).toEqual({ kind: 'existing', target: ConsoleLogger })
    const factory = provide(CONFIG, { inject: [optional(Logger)], useFactory: () => ({ url: 'y' }) }).definition

    expect(factory).toMatchObject({ kind: 'factory', scope: 'singleton', dependencies: [{ token: Logger, optional: true }] })
  })

  it('types factory arguments from the inject list', () => {
    provide(CONFIG, {
      inject: [Logger, optional(ConsoleLogger)],
      useFactory: (logger, console) => {
        const required: Logger = logger
        const maybe: ConsoleLogger | undefined = console

        return { url: `${String(required)}${String(maybe)}` }
      },
    })
  })

  // Checked by the type checker only, never called.
  const typeErrors = (): void => {
    // @ts-expect-error the value must match the token type
    provide(CONFIG, { useValue: { url: 1 } })
    // @ts-expect-error useClass must produce the token type
    provide(CONFIG, { useClass: Logger })
    // @ts-expect-error scope does not apply to values
    provide(CONFIG, { useValue: { url: 'x' }, scope: 'transient' })
    // @ts-expect-error the factory must return the token type
    provide(CONFIG, { useFactory: () => 42 })
  }

  void typeErrors

  it('rejects malformed definitions', async () => {
    await expectDiError(() => provide(CONFIG, {} as never), 'INVALID_PROVIDER', /exactly one of/)
    await expectDiError(
      () => provide(CONFIG, { useValue: { url: 'x' }, useFactory: () => ({ url: 'y' }) } as never),
      'INVALID_PROVIDER',
      /exactly one of/
    )
    await expectDiError(() => provide(Logger, { useExisting: Logger }), 'INVALID_PROVIDER', /alias of itself/)
    await expectDiError(
      () => provide(CONFIG, { useValue: { url: 'x' }, scope: 'transient' } as never),
      'INVALID_PROVIDER',
      /scope only applies/
    )
    await expectDiError(() => provide(Logger, { useClass: ConsoleLogger, scope: 'request' as never }), 'INVALID_PROVIDER', /unknown scope "request"/)
  })

  it('explains undefined tokens, the symptom of a circular file import', async () => {
    await expectDiError(() => provide(undefined as never, { useValue: 1 }), 'INVALID_PROVIDER', /undefined: usually a circular file import/)
    await expectDiError(
      () => provide(CONFIG, { inject: [Logger, undefined as never], useFactory: () => ({ url: 'x' }) }),
      'INVALID_PROVIDER',
      /inject\[1\] is undefined/
    )
    await expectDiError(() => provide(Logger, { useExisting: undefined as never }), 'INVALID_PROVIDER', /useExisting is undefined/)
    await expectDiError(() => inject(undefined as never), 'INVALID_PROVIDER', /inject\(\) received a token that is undefined/)
  })

  it('rejects classes with constructor parameters', async () => {
    class NeedsArguments {
      constructor(readonly name: string) {}
    }
    await expectDiError(
      () => provide(NeedsArguments, { useClass: NeedsArguments as never }),
      'INVALID_PROVIDER',
      /declares 1 constructor parameter\(s\).*inject\(\)/
    )
  })
})
