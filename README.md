# Soda

A class-based web framework for [Bun](https://bun.sh): modules, dependency injection and decorators like [Nest](https://nestjs.com), running on Bun's native router.

```bash
bun create soda my-app
```

| Package | |
|---|---|
| [`@getsoda/core`](./packages/core) | the framework |
| [`create-soda`](./packages/create-soda) | project generator |

## Development

```bash
bun install
bun run lint
bun run typecheck
bun run build
bun run test
```

Releases are published by GitHub Actions from tags: `core-v0.2.0` publishes `@getsoda/core`, `create-soda-v0.2.0` publishes `create-soda`; the tag must match the package version.

## License

[MIT](./LICENSE)
