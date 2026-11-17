import { describe, expect, it } from 'bun:test'
import { createContainer, inject, Module, provide } from '../di/index.ts'
import { Logger } from '../logger/index.ts'
import type { LogEntry } from '../logger/index.ts'
import { Command, CommandBus, CommandHandler, CqrsError, CqrsModule, EventBus, EventsHandler, getHandlerInfo, Query, QueryBus, QueryHandler } from './index.ts'

class MemoryLogger extends Logger {
  readonly entries: LogEntry[] = []

  write(entry: LogEntry): void {
    this.entries.push(entry)
  }
}

interface User {
  readonly id: number
  readonly name: string
}

// Two modules that need each other, through the buses: neither imports the other.

class CreateUser extends Command<User> {
  constructor(readonly name: string) {
    super()
  }
}

class GetUser extends Query<User | undefined> {
  constructor(readonly id: number) {
    super()
  }
}

class UserCreated {
  constructor(readonly user: User) {}
}

class PlaceOrder extends Command<{ readonly orderId: number; readonly buyer: string }> {
  constructor(readonly userId: number) {
    super()
  }
}

class UsersStore {
  readonly users = new Map<number, User>()
}

@CommandHandler(CreateUser)
class CreateUserHandler {
  readonly #store = inject(UsersStore)
  readonly #events = inject(EventBus)

  async execute(command: CreateUser): Promise<User> {
    const user = { id: this.#store.users.size + 1, name: command.name }

    this.#store.users.set(user.id, user)
    await this.#events.publish(new UserCreated(user))

    return user
  }
}

@QueryHandler(GetUser)
class GetUserHandler {
  readonly #store = inject(UsersStore)

  execute(query: GetUser): User | undefined {
    return this.#store.users.get(query.id)
  }
}

const welcomed: string[] = []

@EventsHandler(UserCreated)
class OpenCart {
  handle(event: UserCreated): void {
    welcomed.push(`cart for ${event.user.name}`)
  }
}

@CommandHandler(PlaceOrder)
class PlaceOrderHandler {
  readonly #queries = inject(QueryBus)

  async execute(command: PlaceOrder) {
    const user = await this.#queries.execute(new GetUser(command.userId))

    return { orderId: 1, buyer: user?.name ?? 'nobody' }
  }
}

@Module({ providers: [UsersStore, CreateUserHandler, GetUserHandler] })
class UsersModule {}

@Module({ providers: [OpenCart, PlaceOrderHandler] })
class OrdersModule {}

@Module({ imports: [CqrsModule, UsersModule, OrdersModule] })
class AppModule {}

const start = async (root = AppModule) => {
  const logger = new MemoryLogger()
  const container = await createContainer(root, { providers: [provide(Logger, { useValue: logger })] })

  return { logger, container, commands: container.get(CommandBus), queries: container.get(QueryBus), events: container.get(EventBus) }
}

describe('CommandBus and QueryBus', () => {
  it('give a message to its handler, in whichever module provides it, and resolve with its result', async () => {
    const { commands, queries, container } = await start()

    const user = await commands.execute(new CreateUser('Ada'))
    const order = await commands.execute(new PlaceOrder(user.id))

    expect(user).toEqual({ id: 1, name: 'Ada' })
    expect(order).toEqual({ orderId: 1, buyer: 'Ada' })
    expect(await queries.execute(new GetUser(1))).toEqual(user)
    expect(await queries.execute(new GetUser(2))).toBeUndefined()

    await container.close()
  })

  it('reject with what the handler throws', async () => {
    class Fail extends Command {}

    @CommandHandler(Fail)
    class FailHandler {
      execute(): void {
        throw new Error('refused')
      }
    }

    @Module({ imports: [CqrsModule], providers: [FailHandler] })
    class FailModule {}

    const { commands } = await start(FailModule)

    await expect(commands.execute(new Fail())).rejects.toThrow('refused')
  })

  it('say what is missing: a handler, its provider, one provider only, an instance', async () => {
    class Nobody extends Command {}

    class Unlisted extends Query<number> {}

    @QueryHandler(Unlisted)
    class UnlistedHandler {
      execute(): number {
        return 1
      }
    }

    class Twice extends Command {}

    @CommandHandler(Twice)
    class TwiceHandler {
      execute(): void {}
    }

    @Module({ providers: [TwiceHandler] })
    class LeftModule {}

    @Module({ providers: [TwiceHandler] })
    class RightModule {}

    @Module({ imports: [CqrsModule, LeftModule, RightModule] })
    class BrokenModule {}

    const { commands, queries } = await start(BrokenModule)

    expect(getHandlerInfo(UnlistedHandler)).toEqual({ kind: 'query', messages: [Unlisted] })

    await expect(commands.execute(new Nobody())).rejects.toMatchObject({
      code: 'NO_HANDLER',
      message: 'No handler for Nobody: declare one with @CommandHandler(Nobody), and list it in the providers of a module',
    })
    await expect(queries.execute(new Unlisted())).rejects.toMatchObject({
      code: 'HANDLER_NOT_PROVIDED',
      message: 'UnlistedHandler handles Unlisted, but no module provides it: list it in the providers of a module',
    })
    await expect(commands.execute(new Twice())).rejects.toMatchObject({ code: 'AMBIGUOUS_HANDLER', message: expect.stringContaining('LeftModule and RightModule') })
    // @ts-expect-error A command is an instance of its class.
    await expect(commands.execute({ name: 'Ada' })).rejects.toMatchObject({ code: 'INVALID_MESSAGE' })
  })

  it('use the provider tests put in place of a handler', async () => {
    const logger = new MemoryLogger()
    const container = await createContainer(AppModule, {
      providers: [provide(Logger, { useValue: logger })],
      overrides: [provide(GetUserHandler, { useValue: { execute: () => ({ id: 9, name: 'Fake' }) } as unknown as GetUserHandler })],
    })

    expect(await container.get(QueryBus).execute(new GetUser(1))).toEqual({ id: 9, name: 'Fake' })
  })
})

describe('EventBus', () => {
  class Shipped {}

  const handled: string[] = []

  @EventsHandler(Shipped)
  class Notify {
    async handle(): Promise<void> {
      await Bun.sleep(1)
      handled.push('notify')
    }
  }

  @EventsHandler(Shipped, UserCreated)
  class Audit {
    handle(event: Shipped | UserCreated): void {
      if (event instanceof Shipped) {
        throw new Error('audit is down')
      }
    }
  }

  // Not provided below: published to nobody.
  @EventsHandler(Shipped)
  class Elsewhere {
    handle(): void {
      handled.push('elsewhere')
    }
  }

  @Module({ imports: [CqrsModule], providers: [Notify, Audit] })
  class ShippingModule {}

  it('runs every handler the application provides, a failing one logged, without failing the publisher', async () => {
    const { events, logger } = await start(ShippingModule)

    await events.publish(new Shipped())

    expect(handled).toEqual(['notify'])
    expect(logger.entries).toMatchObject([{ level: 'error', context: 'EventBus', message: 'Audit failed to handle Shipped', data: { error: expect.any(Error) } }])
    expect(getHandlerInfo(Elsewhere)).toEqual({ kind: 'event', messages: [Shipped] })
  })

  it('publishes an event nothing handles to nobody, and refuses what is not an instance', async () => {
    const { events } = await start(ShippingModule)

    await expect(events.publish(new (class Unheard {})())).resolves.toBeUndefined()
    await expect(events.publish({})).rejects.toMatchObject({ code: 'INVALID_MESSAGE' })
  })
})

describe('handler decorators', () => {
  it('refuse a second handler for a command or a query, and a second decorator on a class', () => {
    class Pay extends Command {}

    @CommandHandler(Pay)
    class PayHandler {
      execute(): void {}
    }

    expect(() => {
      @CommandHandler(Pay)
      class OtherPayHandler {
        execute(): void {}
      }

      return OtherPayHandler
    }).toThrow(new CqrsError('DUPLICATE_HANDLER', '@CommandHandler(Pay) on OtherPayHandler: PayHandler handles it already, and a command has one handler'))

    class Refund extends Command {}

    expect(() => {
      @CommandHandler(Refund)
      @EventsHandler(Pay)
      class Both {
        execute(): void {}

        handle(): void {}
      }

      return Both
    }).toThrow('Both is already the handler of Pay: a class handles one kind of message')

    expect(getHandlerInfo(PayHandler)).toEqual({ kind: 'command', messages: [Pay] })
  })
})

// Checked by the type checker: each @ts-expect-error must stay an error.
export const typed = async (commands: CommandBus) => {
  const user: User = await commands.execute(new CreateUser('Ada'))

  // @ts-expect-error A CreateUser resolves with a User.
  const name: string = await commands.execute(new CreateUser('Ada'))

  class Rename extends Command<User> {}

  // @ts-expect-error The handler returns what the command says.
  @CommandHandler(Rename)
  class RenameHandler {
    execute(): string {
      return 'Ada'
    }
  }

  // @ts-expect-error The handler takes the command it handles.
  @CommandHandler(Rename)
  class WrongInput {
    execute(command: CreateUser): User {
      return { id: 1, name: command.name }
    }
  }

  return [user, name, RenameHandler, WrongInput]
}
