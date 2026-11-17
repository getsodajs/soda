/**
 * @module
 * CQRS for Soda, as `@nestjs/cqrs`: commands, queries and events, each class
 * of message handled by the provider that declares it.
 *
 * ```ts
 * class CreateUser extends Command<User> {
 *   constructor(readonly name: string) {
 *     super()
 *   }
 * }
 *
 * @CommandHandler(CreateUser)
 * class CreateUserHandler {
 *   execute(command: CreateUser): Promise<User> { ... }
 * }
 *
 * @Module({ imports: [CqrsModule], providers: [CreateUserHandler] })
 * class UsersModule {}
 *
 * const user = await inject(CommandBus).execute(new CreateUser('Ada'))   // User
 * ```
 */

export { CommandBus, EventBus, QueryBus } from './buses.ts'
export { CommandHandler, EventsHandler, getHandlerInfo, QueryHandler } from './decorators.ts'
export type { ExecutesCommand, ExecutesQuery, HandlerDecorator, HandlerInfo, HandlesEvent } from './decorators.ts'
export { CqrsError } from './errors.ts'
export type { CqrsErrorCode } from './errors.ts'
export { Command, Query } from './messages.ts'
export type { CommandResult, MessageType, QueryResult } from './messages.ts'
export { CqrsModule } from './module.ts'
