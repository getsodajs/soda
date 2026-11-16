# Checking the application

`soda check` finds what would stop the application from starting, every problem at once, without starting it:

```bash
bun run check:app   # soda check
```

```
  soda check  3 problems  6 ms

  ✖ INVALID_CONFIG  Invalid configuration "app":
      JWT_SECRET: Too small: expected string to have >=32 characters
    src/config.ts:4:26
     4 │ export const AppConfig = defineConfig('app', z.object({
       │                          ^
    fix  Set the variables in the environment or in .env, as the schema of the configuration expects.

  ✖ NO_PROVIDER  No provider for UsersRepository in AppModule (UsersService → UsersRepository).
    src/users/users.service.ts:5:25
     5 │   readonly repository = inject(UsersRepository)
       │                         ^
    fix  DatabaseModule provides it but does not export it: add it to the exports of DatabaseModule.

  ✖ UNKNOWN_PARAM  UsersController.findOne: param('userId') is not a parameter of "/users/:id" (its parameters: id)
    src/users/users.controller.ts:12:16
    12 │   @Get(':id', [param('userId', int)])
       │                ^
```

It exits with `1` when there is a problem, `0` otherwise: a step for CI, a pre-commit hook, or an agent after each change.

## What it checks

What `createApp()` checks at startup, but all of it instead of the first error:

- the graph: missing providers (and where they are provided), providers not exported, ambiguous imports, cycles;
- configurations, against their schemas;
- controllers and gateways: `param()` names, arguments in the wrong place, guards, interceptors and filters and what they inject;
- routes: conflicts between them, a gateway on the path of a route;
- a class failing in its constructor.

## How it works

`soda check` runs the entry of the application (`src/main.ts`, or the file given: `soda check src/worker.ts`). When that file calls `createApp()`, the application is checked instead of started, with the very options passed to `createApp()`:

- classes are created, since their `inject()` calls are their dependencies;
- factories are not called: they open connections; their `inject` lists are checked;
- configurations are loaded, from the environment `soda check` runs in;
- no `onInit` runs, nothing listens, nothing is left open.

Code before `createApp()` in the entry runs as usual: keep it free of side effects, as the templates do.

## For agents

`--json` writes the report as data:

```bash
soda check --json
```

```json
{
  "ok": false,
  "problems": [
    {
      "code": "NO_PROVIDER",
      "message": "No provider for UsersRepository in AppModule (UsersService → UsersRepository).",
      "fix": "DatabaseModule provides it but does not export it: add it to the exports of DatabaseModule.",
      "file": "src/users/users.service.ts",
      "line": 5,
      "column": 25
    }
  ],
  "duration": 6.2,
  "modules": 4,
  "providers": 9,
  "routes": 7
}
```

Each problem has a stable `code`, the place in your code and, when there is one obvious way, the `fix`. An agent can change the code, run `soda check --json`, and repeat until `ok` is `true`, in milliseconds and without a database.

## In tests

`checkApp()` is what the command runs:

```ts
import { checkApp } from '@getsoda/core'
import { AppModule } from './app.module.ts'

test('the application starts', async () => {
  expect((await checkApp(AppModule)).problems).toEqual([])
})
```
