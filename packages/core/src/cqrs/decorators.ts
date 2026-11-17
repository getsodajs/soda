/**
 * @module
 * Handler decorators, as in `@nestjs/cqrs`: a handler is a provider, listed in
 * the `providers` of a module, whose class says what it handles.
 *
 * A command or a query has one handler, an event any number. A second handler
 * for a command is an error when its class is defined, not a warning and an
 * override, as Nest has it.
 */

import type { Constructor } from '../di/index.ts'
import { CqrsError } from './errors.ts'
import type { Command, CommandResult, MessageType, Query, QueryResult } from './messages.ts'

/** What a class decorated by `@CommandHandler()`, `@QueryHandler()` or `@EventsHandler()` handles. */
export interface HandlerInfo {
  readonly kind: 'command' | 'query' | 'event'
  readonly messages: readonly MessageType<object>[]
}

/** Class decorator of a handler. */
export type HandlerDecorator<H> = <T extends Constructor<H>>(target: T, context: ClassDecoratorContext<T>) => void

// Function properties, not methods: the compiler then checks the parameter strictly,
// so a handler cannot take another command than the one it is declared for.

/** What a command handler implements: the bus calls `execute()`. */
export interface ExecutesCommand<C extends Command<unknown>> {
  readonly execute: (command: C) => CommandResult<C> | Promise<CommandResult<C>>
}

/** What a query handler implements: the bus calls `execute()`. */
export interface ExecutesQuery<Q extends Query<unknown>> {
  readonly execute: (query: Q) => QueryResult<Q> | Promise<QueryResult<Q>>
}

/** What an event handler implements: the bus calls `handle()`. */
export interface HandlesEvent<E> {
  readonly handle: (event: E) => unknown
}

const infos = new WeakMap<object, HandlerInfo>()
const singles = { command: new WeakMap<object, Constructor<unknown>>(), query: new WeakMap<object, Constructor<unknown>>() }
const events = new WeakMap<object, Constructor<unknown>[]>()

const record = (target: Constructor<unknown>, info: HandlerInfo): void => {
  const existing = infos.get(target)

  if (existing !== undefined) {
    throw new CqrsError('DUPLICATE_HANDLER', `${target.name} is already the handler of ${existing.messages.map((type) => type.name).join(', ')}: a class handles one kind of message`)
  }

  infos.set(target, info)
}

const single =
  (kind: 'command' | 'query', decorator: string, type: MessageType<object>) =>
  (target: Constructor<unknown>): void => {
    const handler = singles[kind].get(type)

    if (handler !== undefined) {
      throw new CqrsError('DUPLICATE_HANDLER', `@${decorator}(${type.name}) on ${target.name}: ${handler.name} handles it already, and a ${kind} has one handler`)
    }

    record(target, { kind, messages: [type] })
    singles[kind].set(type, target)
  }

/**
 * Declares the handler of a command: `CommandBus.execute()` calls its `execute()`,
 * whose type the compiler checks against the command.
 *
 * ```ts
 * @CommandHandler(CreateUser)
 * class CreateUserHandler {
 *   readonly #db = inject(Database)
 *
 *   execute(command: CreateUser): Promise<User> {
 *     return this.#db.users.insert({ name: command.name })
 *   }
 * }
 * ```
 */
export const CommandHandler = <C extends Command<unknown>>(command: MessageType<C>): HandlerDecorator<ExecutesCommand<C>> =>
  single('command', 'CommandHandler', command)

/** Declares the handler of a query: `QueryBus.execute()` calls its `execute()`. */
export const QueryHandler = <Q extends Query<unknown>>(query: MessageType<Q>): HandlerDecorator<ExecutesQuery<Q>> =>
  single('query', 'QueryHandler', query)

/**
 * Declares a handler of one event or more: `EventBus.publish()` calls the
 * `handle()` of every handler of the event.
 *
 * ```ts
 * @EventsHandler(UserCreated)
 * class SendWelcomeEmail {
 *   handle(event: UserCreated) { ... }
 * }
 * ```
 */
export const EventsHandler =
  <const E extends readonly [MessageType<object>, ...MessageType<object>[]]>(...types: E): HandlerDecorator<HandlesEvent<InstanceType<E[number]>>> =>
  (target) => {
    record(target, { kind: 'event', messages: types })

    for (const type of types) {
      events.set(type, [...(events.get(type) ?? []), target])
    }
  }

/** The handler class of a command or a query, `undefined` without one. */
export const handlerOf = (kind: 'command' | 'query', type: object): Constructor<unknown> | undefined => singles[kind].get(type)

/** The handler classes of an event, in the order they were defined. */
export const eventHandlersOf = (type: object): readonly Constructor<unknown>[] => events.get(type) ?? []

/** What a handler class handles, `undefined` for another class. */
export const getHandlerInfo = (target: unknown): HandlerInfo | undefined => (typeof target === 'function' ? infos.get(target) : undefined)
