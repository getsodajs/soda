# Soda app

Created with `create-soda`. Requires [Bun](https://bun.sh).

```bash
bun install
bun dev          # bun --hot: reloads on change
bun debug        # the same, with the inspector
bun test         # test:watch, test:cov
bun typecheck
bun check:app    # soda check: startup problems, without starting
bun lint         # oxlint; lint:fix
bun run build    # bundles src/main.ts into dist/
bun start:prod   # runs the bundle
```

- `src/config.ts`: the configuration, read from `.env` and checked at startup.
- `src/auth`: sign-in with JWT, returned as a token and set as an httpOnly cookie.
- `src/users`: a module with a service and a controller; writes need a token.
- `src/app.test.ts`: tests over HTTP, with the configuration replaced.

`.env` was created from `.env.example` with a random `JWT_SECRET`; it is not committed.

Try it:

```bash
TOKEN=$(curl -s localhost:3000/auth/login -H 'content-type: application/json' -d '{"name":"ann"}' | jq -r .token)
curl -X POST localhost:3000/users -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"name":"Bo"}'
curl localhost:3000/users/1
```
