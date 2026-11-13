import { inject, Logger } from '@getsoda/core'

export interface User {
  readonly id: number
  readonly name: string
  readonly createdBy: string
}

export class UsersService {
  readonly #logger = inject(Logger).child('UsersService')
  readonly #users = new Map<number, User>()

  list(): User[] {
    return [...this.#users.values()]
  }

  find(id: number): User | undefined {
    return this.#users.get(id)
  }

  create(name: string, createdBy: string): User {
    const user = { id: this.#users.size + 1, name, createdBy }

    this.#users.set(user.id, user)
    this.#logger.log('User created', { id: user.id })

    return user
  }
}
