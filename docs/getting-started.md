# Getting started

## Requirements

Bun 1.4 or later. No TypeScript flags are needed: Soda uses standard decorators, not `experimentalDecorators`.

## Create a project

```bash
bun create soda my-app
cd my-app
bun dev
```

`bun create soda` asks for the directory, the template and whether to install dependencies. Two templates exist:

| Template | |
|---|---|
| `minimal` | a module, a controller, a service and a test; the default |
| `demo` | configuration, login with JWT in an httpOnly cookie, users with validation, CORS, tests |

Without a terminal, or in CI:

```bash
bun create soda my-app --template demo --install --no-interactive
```

Open <http://localhost:3000>: the application answers `Hello Soda!`.

## What is in it

```
src/
  main.ts            creates the application and listens
  app.module.ts      the root module
  app.controller.ts  routes
  app.service.ts     what the routes use
  app.test.ts        a test over HTTP
```

`main.ts` starts everything:

```ts
import { createApp } from '@getsoda/core'
import { AppModule } from './app.module.ts'

const app = await createApp(AppModule)

app.enableShutdownSignals() // close gracefully on SIGTERM and SIGINT
await app.listen(Number(process.env.PORT ?? 3000))
```

A module lists its providers and controllers:

```ts
@Module({ providers: [AppService], controllers: [AppController] })
export class AppModule {}
```

A controller gets what it needs with `inject()`, and declares routes on its methods:

```ts
@Controller()
export class AppController {
  readonly #app = inject(AppService)

  @Get()
  getHello(): string {
    return this.#app.getHello()
  }
}
```

At startup Soda logs the modules, the controllers and each route, as Nest does.

## Scripts

| Script | |
|---|---|
| `bun dev` | runs with `bun --hot`: changes apply without a restart |
| `bun run debug` | the same, with the inspector |
| `bun start` | runs the sources |
| `bun run build` | bundles into `dist/main.js` |
| `bun run start:prod` | runs the bundle |
| `bun test`, `test:watch`, `test:cov` | tests, with coverage for `test:cov` |
| `bun run typecheck` | `bun check` |
| `bun run check:app` | [`soda check`](./check.md): what would stop the application from starting, without starting it |
| `bun run lint`, `lint:fix` | oxlint |

## Your first resource

A service holding users:

```ts
// src/users/users.service.ts
export interface User {
  readonly id: number
  readonly name: string
}

export class UsersService {
  readonly #users = new Map<number, User>()

  find(id: number): User | undefined {
    return this.#users.get(id)
  }

  create(name: string): User {
    const user = { id: this.#users.size + 1, name }

    this.#users.set(user.id, user)

    return user
  }
}
```

A controller: the route decorator lists the arguments the method receives, read and validated before it runs.

```ts
// src/users/users.controller.ts
import { body, Controller, Get, inject, int, NotFoundException, param, Post } from '@getsoda/core'
import { z } from 'zod'
import { UsersService } from './users.service.ts'
import type { User } from './users.service.ts'

const CreateUser = z.object({ name: z.string().min(1) })

@Controller('users')
export class UsersController {
  readonly #users = inject(UsersService)

  @Get(':id', [param('id', int)])
  findOne(id: number): User {
    const user = this.#users.find(id)

    if (user === undefined) {
      throw new NotFoundException(`No user ${id}`)
    }

    return user
  }

  @Post([body(CreateUser)])
  create(input: z.infer<typeof CreateUser>): User {
    return this.#users.create(input.name)
  }
}
```

A module for them, imported by the root module:

```ts
// src/users/users.module.ts
@Module({ providers: [UsersService], controllers: [UsersController] })
export class UsersModule {}

// src/app.module.ts
@Module({ imports: [UsersModule], providers: [AppService], controllers: [AppController] })
export class AppModule {}
```

```bash
curl -X POST localhost:3000/users -H 'content-type: application/json' -d '{"name":"Ann"}'
# {"id":1,"name":"Ann"}
curl localhost:3000/users/1
# {"id":1,"name":"Ann"}
curl localhost:3000/users/abc
# {"statusCode":400,"message":"Validation failed for \"id\" (integer string is expected)","error":"Bad Request"}
```

Next: [Controllers](./controllers.md).
