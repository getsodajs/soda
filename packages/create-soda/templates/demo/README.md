# Soda app

Created with `create-soda`. Requires [Bun](https://bun.sh).

```bash
bun install
bun dev          # bun --hot: reloads on change
bun debug        # the same, with the inspector
bun test         # test:watch, test:cov
bun typecheck
bun lint         # oxlint; lint:fix
bun run build    # bundles src/main.ts into dist/
bun start:prod   # runs the bundle
```

- `src/main.ts`: creates the application, CORS, graceful shutdown.
- `src/users`: a module with a service, a controller and a test.
- `src/auth/auth.guard.ts`: a guard passing the current user to handlers.

Try it:

```bash
curl -X POST localhost:3000/users -H 'authorization: Bearer ann' -H 'content-type: application/json' -d '{"name":"Bo"}'
curl localhost:3000/users/1
```
