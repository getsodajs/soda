# create-soda

Creates a [Soda](https://github.com/getsodajs/soda) project.

```bash
bun create soda my-app
```

or `npm create soda@latest my-app`. Then:

```bash
cd my-app
bun install
bun dev
```

The project has a users module (service, controller, test), a guard passing the current user to handlers, CORS and graceful shutdown.

## Options

| Option | |
|---|---|
| `[directory]` | where to create the project; asked in a terminal, `soda-app` otherwise |
| `--overwrite` | empty a non-empty directory first (`.git` is kept) |
| `--no-interactive` | never ask, for scripts and CI |
| `--core-version <range>` | version of `@getsoda/core` to depend on |

## License

[MIT](./LICENSE)
