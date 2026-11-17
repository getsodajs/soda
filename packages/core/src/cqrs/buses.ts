/**
 * @module
 * `CommandBus`, `QueryBus` and `EventBus`, as in `@nestjs/cqrs`, without RxJS.
 *
 * A bus finds the handler of a message by its class, among the providers of
 * every module. Services inject a bus, not each other: a command handler
 * needing what another module does executes its command, without importing it.
 */

import { Discovery, inject } from '../di/index.ts'
import type { Constructor, DiscoveredProvider } from '../di/index.ts'
import { Logger } from '../logger/index.ts'
import { eventHandlersOf, handlerOf } from './decorators.ts'
import type { ExecutesCommand, ExecutesQuery, HandlesEvent } from './decorators.ts'
import { CqrsError } from './errors.ts'
import type { Command, Query } from './messages.ts'

/** The class of `message`, which must be an instance of one. */
const typeOf = (message: unknown, what: string): Constructor<unknown> => {
  const type = typeof message === 'object' && message !== null ? (message as object).constructor : undefined

  if (typeof type !== 'function' || type === Object) {
    throw new CqrsError('INVALID_MESSAGE', `${what} is an instance of its class, such as new CreateUser(...), not ${message === null ? 'null' : typeof message === 'object' ? 'a plain object' : typeof message}`)
  }

  return type as Constructor<unknown>
}

/** The providers of handler classes, looked up once. */
class Providers {
  readonly #discovery = inject(Discovery)
  readonly #found = new Map<Constructor<unknown>, readonly DiscoveredProvider[]>()

  of(handler: Constructor<unknown>): readonly DiscoveredProvider[] {
    let found = this.#found.get(handler)

    if (found === undefined) {
      found = this.#discovery.providers().filter((provider) => provider.token === handler)
      this.#found.set(handler, found)
    }

    return found
  }

  /** The handler of a command or a query: declared, and provided by one module. */
  single(kind: 'command' | 'query', message: unknown): unknown {
    const type = typeOf(message, kind === 'command' ? 'A command' : 'A query')
    const handler = handlerOf(kind, type)
    const decorator = kind === 'command' ? 'CommandHandler' : 'QueryHandler'

    if (handler === undefined) {
      throw new CqrsError('NO_HANDLER', `No handler for ${type.name}: declare one with @${decorator}(${type.name}), and list it in the providers of a module`)
    }

    const found = this.of(handler)

    if (found.length === 0) {
      throw new CqrsError('HANDLER_NOT_PROVIDED', `${handler.name} handles ${type.name}, but no module provides it: list it in the providers of a module`)
    }

    if (found.length > 1) {
      throw new CqrsError('AMBIGUOUS_HANDLER', `${handler.name} handles ${type.name}, and is provided by ${found.map((provider) => provider.module.name).join(' and ')}: list it in one module`)
    }

    return found[0]!.get()
  }
}

/**
 * Executes commands: `await inject(CommandBus).execute(new CreateUser('Ada'))`.
 * Resolves with what the handler returns, typed by the command; rejects with
 * what it throws, or a `CqrsError` when nothing handles the command.
 */
export class CommandBus {
  readonly #providers = new Providers()

  async execute<R>(command: Command<R>): Promise<R> {
    return (this.#providers.single('command', command) as ExecutesCommand<Command<R>>).execute(command) as R
  }
}

/** Executes queries: `await inject(QueryBus).execute(new GetUser(7))`, as `CommandBus` does commands. */
export class QueryBus {
  readonly #providers = new Providers()

  async execute<R>(query: Query<R>): Promise<R> {
    return (this.#providers.single('query', query) as ExecutesQuery<Query<R>>).execute(query) as R
  }
}

/**
 * Publishes events to their handlers: `inject(EventBus).publish(new UserCreated(user))`.
 *
 * Every handler of the event runs, at the same time. A failing handler is
 * logged and leaves the others and the publisher alone, as in Nest: an email
 * that cannot be sent does not undo the user it welcomes. The promise resolves
 * once every handler has finished; not awaiting it publishes in the background.
 * An event without handlers is published to nobody, without error.
 */
export class EventBus {
  readonly #providers = new Providers()
  readonly #logger = inject(Logger).child('EventBus')

  async publish(event: object): Promise<void> {
    const type = typeOf(event, 'An event')
    const handlers = eventHandlersOf(type).flatMap((handler) => this.#providers.of(handler))

    await Promise.all(
      handlers.map(async (provider) => {
        const handler = provider.get() as HandlesEvent<object>

        try {
          await handler.handle(event)
        } catch (error) {
          this.#logger.error(`${(provider.token as Constructor<unknown>).name} failed to handle ${type.name}`, { error })
        }
      })
    )
  }
}
