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

- `src/main.ts`: creates the application and starts listening.
- `src/app.module.ts`: the root module.
- `src/app.controller.ts`, `src/app.service.ts`: `GET /` answers `Hello Soda!`.
