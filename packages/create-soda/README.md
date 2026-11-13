# create-soda

Creates a [Soda](https://github.com/getsodajs/soda) project.

```bash
bun create soda my-app
```

or `npm create soda@latest my-app`. In a terminal it asks for the directory, the template and whether to install dependencies; then:

```bash
cd my-app
bun dev
```

## Templates

| Template | |
|---|---|
| `minimal` | a module, a controller, a service and a test; the default |
| `demo` | users with validation, a guard passing the current user to handlers, logging, CORS and graceful shutdown |

## Options

| Option | |
|---|---|
| `[directory]` | where to create the project; asked in a terminal, `soda-app` otherwise |
| `-t, --template <name>` | template to use; asked in a terminal, `minimal` otherwise |
| `--install`, `--no-install` | install dependencies; asked in a terminal, not installed otherwise |
| `--overwrite` | empty a non-empty directory first (`.git` is kept) |
| `--no-interactive` | never ask, for scripts and CI |
| `--core-version <range>` | version of `@getsoda/core` to depend on |

```bash
bun create soda my-app --template demo --install --no-interactive
```

## License

[MIT](./LICENSE)
