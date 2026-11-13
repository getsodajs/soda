# Soda

A class-based web framework for [Bun](https://bun.sh): modules, dependency injection and decorators like [Nest](https://nestjs.com), running on Bun's native router.

- **Standard decorators.** TC39 decorators, no `experimentalDecorators`, no `reflect-metadata`.
- **Native routing.** Routes compile into `Bun.serve({ routes })`; a route without guards adds ~0.1 ns to calling the handler.
- **Modules and DI.** `inject()`, providers, async factories, global and dynamic modules, lifecycle hooks. Graph errors are reported at startup with the full resolution chain.
- **Typed requests.** Path parameters are typed from the route path; bodies are validated with any [Standard Schema](https://standardschema.dev) library (zod, valibot, arktype).
- **Request pipeline.** Guards, interceptors and exception filters, as classes, instances or functions.
- **Lifecycle.** Graceful shutdown that drains requests before destroying services, shutdown signals, `bun --hot` support.

> Soda is in early development (0.x): the API may change between minor versions.

## Install

```bash
bun add @getsoda/core
```

Requires Bun 1.4 or later. No TypeScript flags are needed for decorators.

## Quick start

```ts
import { Controller, Get, Module, Post, body, createApp, inject, int, param } from '@getsoda/core'
import type { Context } from '@getsoda/core'
import { z } from 'zod'

const CreateUser = z.object({ name: z.string().min(1) })

class UsersService {
  readonly #users = new Map<number, { id: number; name: string }>()

  find(id: number) {
    return this.#users.get(id)
  }

  create(name: string) {
    const user = { id: this.#users.size + 1, name }

    this.#users.set(user.id, user)

    return user
  }
}

@Controller('users')
class UsersController {
  readonly #users = inject(UsersService)

  // Ready values, Nest style
  @Get(':id', [param('id', int())])
  findOne(id: number) {
    return this.#users.find(id)
  }

  // Or read from the context where needed
  @Post()
  async create(ctx: Context) {
    const { name } = await ctx.body(CreateUser)

    return this.#users.create(name)
  }
}

@Module({ providers: [UsersService], controllers: [UsersController] })
class AppModule {}

const app = await createApp(AppModule)

app.enableShutdownSignals()
await app.listen(3000)
```

## Cookies

`ctx.cookies` is Bun's `CookieMap` for the request: what you set or delete is sent with the response, whatever the response is. Signed cookies can be read by the client but not forged:

```ts
import { CookieSigner, cookie, signed } from '@getsoda/core'

const signer = new CookieSigner(process.env.COOKIE_SECRET!) // or [current, previous] to rotate

@Controller('session')
class SessionController {
  @Post()
  login(ctx: Context) {
    ctx.cookies.set('session', signer.sign('user-1'), { httpOnly: true, secure: true, sameSite: 'strict' })
  }

  @Get([cookie('session', signed(signer))]) // 400 when missing or forged
  me(userId: string) {
    return { userId }
  }
}
```

Name cookies that guard sessions with the `__Host-` prefix: browsers then refuse them from subdomains and over HTTP.

## License

[MIT](./LICENSE)
