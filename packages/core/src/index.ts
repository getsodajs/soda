/**
 * @module
 * Soda: a class-based web framework for Bun, with modules and dependency
 * injection like Nest, standard TC39 decorators, and Bun's native router.
 *
 * ```ts
 * import { Context, Controller, Get, Module, createApp, inject } from '@getsoda/core'
 *
 * class Greeter {
 *   greet(name: string) {
 *     return `Hello, ${name}`
 *   }
 * }
 *
 * @Controller('/hello')
 * class HelloController {
 *   readonly #greeter = inject(Greeter)
 *
 *   @Get(':name')
 *   hello(ctx: Context<':name'>) {
 *     return this.#greeter.greet(ctx.param('name'))
 *   }
 * }
 *
 * @Module({ providers: [Greeter], controllers: [HelloController] })
 * class AppModule {}
 *
 * const app = await createApp(AppModule)
 *
 * await app.listen(3000)
 * ```
 */

export * from './app/index.ts'
export * from './di/index.ts'
export * from './http/index.ts'
export * from './logger/index.ts'
export * from './routing/index.ts'
