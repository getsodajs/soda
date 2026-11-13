import { body, Controller, Get, inject, int, NotFoundException, param, Post, UseGuards, value } from '@getsoda/core'
import { z } from 'zod'
import { AuthGuard, CURRENT_USER } from '../auth/auth.guard.ts'
import type { CurrentUser } from '../auth/auth.guard.ts'
import { UsersService } from './users.service.ts'
import type { User } from './users.service.ts'

const CreateUser = z.object({ name: z.string().trim().min(1) })

@Controller('users')
export class UsersController {
  readonly #users = inject(UsersService)

  @Get()
  list(): User[] {
    return this.#users.list()
  }

  @Get(':id', [param('id', int())])
  findOne(id: number): User {
    const user = this.#users.find(id)

    if (user === undefined) {
      throw new NotFoundException(`User ${id} not found`)
    }

    return user
  }

  @Post([body(CreateUser), value(CURRENT_USER)])
  @UseGuards(AuthGuard)
  create(input: z.infer<typeof CreateUser>, currentUser: CurrentUser): User {
    return this.#users.create(input.name, currentUser.name)
  }
}
