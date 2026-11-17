import { body, Controller, Get, inject, int, NotFoundException, param, Post, Returns, UseGuards, value } from '@getsoda/core'
import { JWT_PAYLOAD, JwtGuard } from '@getsoda/core/jwt'
import type { JwtPayload } from '@getsoda/core/jwt'
import { z } from 'zod'
import { User, UsersService } from './users.service.ts'

const CreateUser = z.object({ name: z.string().trim().min(1) })

type CreateUser = z.infer<typeof CreateUser>

@Controller('users')
export class UsersController {
  readonly #users = inject(UsersService)

  @Get()
  @Returns(z.array(User))
  list() {
    return this.#users.list()
  }

  @Get(':id', [param('id', int)])
  @Returns(User)
  findOne(id: number) {
    const user = this.#users.find(id)

    if (user === undefined) {
      throw new NotFoundException(`User ${id} not found`)
    }

    return user
  }

  @Post([body(CreateUser), value(JWT_PAYLOAD)])
  @UseGuards(JwtGuard)
  @Returns(User)
  create(input: CreateUser, author: JwtPayload) {
    return this.#users.create(input.name, author.sub ?? 'unknown')
  }
}
