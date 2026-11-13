import { expect, it } from 'bun:test'
import { createContainer, inject, Module } from '../di/index.ts'

it('keeps the frames of the framework out of errors about the application', async () => {
  class Missing {}

  class Service {
    readonly missing = inject(Missing)
  }

  @Module({ providers: [Service] })
  class AppModule {}

  const error = (await createContainer(AppModule).catch((caught: unknown) => caught)) as Error
  const framework = new URL('../', import.meta.url).pathname

  expect(error.message).toBe(
    'No provider for Missing in AppModule (Service → Missing). Add it to the providers of AppModule, or import a module that exports it.'
  )
  expect(error.stack).toStartWith('DiError: No provider for Missing')
  expect(error.stack).not.toContain(framework)
})
