# Database

Soda has no database module, and needs none: a client is a provider, opened at startup and closed with the application. The same pattern fits any library, as Nest's Prisma recipe does.

## Bun.sql

Bun has a PostgreSQL and MySQL client built in, with pooling and tagged templates that escape values.

```ts
// src/database/database.ts
import { SQL } from 'bun'
import type { OnDestroy, OnInit } from '@getsoda/core'
import { inject } from '@getsoda/core'
import { DatabaseConfig } from './database.config.ts'

export class Database implements OnInit, OnDestroy {
  readonly sql = new SQL(inject(DatabaseConfig).url)

  async onInit() {
    await this.sql`select 1` // fail at startup when the database is unreachable
  }

  onDestroy() {
    return this.sql.close()
  }
}
```

```ts
// src/database/database.module.ts
@Module({ providers: [Database], exports: [Database], global: true })
export class DatabaseModule {}
```

```ts
export class UsersRepository {
  readonly #db = inject(Database)

  async find(id: number): Promise<User | undefined> {
    const [user] = await this.#db.sql<User[]>`select id, name from users where id = ${id}`

    return user
  }

  create(name: string) {
    return this.#db.sql.begin(async (tx) => {
      const [user] = await tx`insert into users (name) values (${name}) returning id, name`
      await tx`insert into audit (action) values ('user created')`

      return user
    })
  }
}
```

`onDestroy` runs after the last request has been served, so no query meets a closed pool.

## Drizzle

Drizzle builds queries and types; a driver sends them. On Bun, `drizzle-orm/bun-sql` runs on `Bun.sql`, so no other driver is installed.

```ts
import { drizzle } from 'drizzle-orm/bun-sql'
import type { BunSQLDatabase } from 'drizzle-orm/bun-sql'
import { SQL } from 'bun'
import * as schema from './schema.ts'

export class Database implements OnDestroy {
  readonly #client = new SQL(inject(DatabaseConfig).url)
  readonly db: BunSQLDatabase<typeof schema> = drizzle({ client: this.#client, schema })

  onDestroy() {
    return this.#client.close()
  }
}
```

```ts
import { eq } from 'drizzle-orm'
import { users } from './schema.ts'

export class UsersRepository {
  readonly #db = inject(Database).db

  async find(id: number) {
    const [user] = await this.#db.select().from(users).where(eq(users.id, id))

    return user
  }
}
```

Other drivers (`drizzle-orm/postgres-js`, `drizzle-orm/node-postgres`, `drizzle-orm/bun-sqlite`) fit the same class.

## Prisma

```ts
import { PrismaClient } from '../generated/prisma/client.ts' // where your Prisma generator writes the client

export class PrismaService extends PrismaClient implements OnInit, OnDestroy {
  async onInit() {
    await this.$connect()
  }

  async onDestroy() {
    await this.$disconnect()
  }
}

@Module({ providers: [PrismaService], exports: [PrismaService], global: true })
export class PrismaModule {}
```

```ts
readonly #prisma = inject(PrismaService)

findOne(id: number) {
  return this.#prisma.user.findUnique({ where: { id } })
}
```

## SQLite

`bun:sqlite` is synchronous and in-process: one `Database` provider, closed in `onDestroy`.

```ts
import { Database as SQLite } from 'bun:sqlite'

export class Database implements OnDestroy {
  readonly sqlite = new SQLite('app.db', { strict: true })

  onDestroy() {
    this.sqlite.close()
  }
}
```

## In tests

Replace the provider, or point the configuration at a test database:

```ts
await createTestApp(AppModule, {
  overrides: [provide(DatabaseConfig, { useValue: { url: process.env.TEST_DATABASE_URL! } })],
})
```

For a fast suite, replace the repository instead of the database: `provide(UsersRepository, { useClass: MemoryUsersRepository })`.

## Errors

Map database errors to HTTP in an exception filter rather than in each route:

```ts
@Catch(SQL.PostgresError)
export class UniqueViolationFilter implements ExceptionFilter<SQL.PostgresError> {
  catch(error: SQL.PostgresError) {
    if (error.errno === '23505') {
      return Response.json({ statusCode: 409, message: 'Already exists', error: 'Conflict' }, { status: 409 })
    }

    throw error // a failing filter falls back to the default: logged, a bare 500
  }
}
```
