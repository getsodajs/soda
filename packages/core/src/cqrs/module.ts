/**
 * @module
 * `CqrsModule`: the three buses.
 */

import { Module } from '../di/index.ts'
import { CommandBus, EventBus, QueryBus } from './buses.ts'

/**
 * The three buses, in every module once imported anywhere: import it in the root module.
 * Handlers are providers of any module; the buses find them there.
 *
 * ```ts
 * @Module({ imports: [CqrsModule, UsersModule, OrdersModule] })
 * class AppModule {}
 * ```
 */
@Module({ providers: [CommandBus, QueryBus, EventBus], exports: [CommandBus, QueryBus, EventBus], global: true })
export class CqrsModule {}
