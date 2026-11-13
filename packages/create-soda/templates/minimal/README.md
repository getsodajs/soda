# Soda app

Created with `create-soda`. Requires [Bun](https://bun.sh).

```bash
bun install
bun dev        # bun --hot: reloads on change
bun test
bun typecheck
```

- `src/main.ts`: creates the application and starts listening.
- `src/app.module.ts`: the root module.
- `src/app.controller.ts`, `src/app.service.ts`: `GET /` answers `Hello Soda!`.
