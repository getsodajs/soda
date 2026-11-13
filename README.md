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

The packages share one version and are released together by GitHub Actions:

```bash
bun run release:version 0.2.0
git commit -am "chore: release 0.2.0"
git tag -a v0.2.0 -m v0.2.0
git push --follow-tags
```

The tag `v0.2.0` publishes `@getsoda/core` 0.2.0, then `create-soda` 0.2.0, which creates projects depending on that core.

## License

[MIT](./LICENSE)
