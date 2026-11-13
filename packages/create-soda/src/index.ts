#!/usr/bin/env node
/**
 * @module
 * `create-soda`: creates a Soda project.
 *
 * ```bash
 * bun create soda my-app
 * npm create soda@latest my-app
 * ```
 *
 * Interactive in a terminal, flag-driven otherwise (CI, scripts). Uses only
 * Node built-ins, so it runs the same under `npm create` (Node) and `bun create`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { basename, relative, resolve } from 'node:path'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import {
  createProject,
  detectPackageManager,
  emptyDir,
  formatTargetDir,
  isEmptyDir,
  isValidPackageName,
  toValidPackageName,
} from './project.ts'

const DEFAULT_DIR = 'soda-app'

const HELP = `Usage: create-soda [directory] [options]

Creates a Soda project. Interactive in a terminal.

Options:
  --overwrite                   empty the directory if it is not empty
  --interactive, --no-interactive
                                force or disable questions
  --core-version <range>        version of @getsoda/core to depend on
  -h, --help                    show this help
`

interface Arguments {
  readonly dir: string | undefined
  readonly overwrite: boolean
  readonly interactive: boolean | undefined
  readonly coreVersion: string | undefined
  readonly help: boolean
}

const parseArguments = (args: readonly string[]): Arguments => {
  let dir: string | undefined
  let overwrite = false
  let interactive: boolean | undefined
  let coreVersion: string | undefined
  let help = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!

    if (arg === '--overwrite') {
      overwrite = true
    } else if (arg === '--interactive' || arg === '--no-interactive') {
      interactive = arg === '--interactive'
    } else if (arg === '--core-version') {
      coreVersion = args[++i]
    } else if (arg === '-h' || arg === '--help') {
      help = true
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option ${arg}\n\n${HELP}`)
    } else {
      dir ??= arg
    }
  }

  return { dir, overwrite, interactive, coreVersion, help }
}

/** Version range of `@getsoda/core`: written next to the build, or read from the monorepo when run from sources. */
const readCoreVersion = (): string => {
  const built = fileURLToPath(new URL('../core-version.json', import.meta.url))

  if (existsSync(built)) {
    return `^${(JSON.parse(readFileSync(built, 'utf8')) as { version: string }).version}`
  }

  const workspace = fileURLToPath(new URL('../../core/package.json', import.meta.url))

  return `^${(JSON.parse(readFileSync(workspace, 'utf8')) as { version: string }).version}`
}

const main = async (): Promise<void> => {
  const args = parseArguments(process.argv.slice(2))

  if (args.help) {
    stdout.write(HELP)

    return
  }

  const interactive = args.interactive ?? stdin.isTTY === true
  const prompt = interactive ? createInterface({ input: stdin, output: stdout }) : undefined

  try {
    let dir = args.dir === undefined ? '' : formatTargetDir(args.dir)

    if (dir === '' && prompt !== undefined) {
      dir = formatTargetDir((await prompt.question(`Project directory (${DEFAULT_DIR}): `)) || DEFAULT_DIR)
    }

    dir ||= DEFAULT_DIR

    if (!(await isEmptyDir(dir))) {
      const overwrite =
        args.overwrite ||
        (prompt !== undefined &&
          /^y(?:es)?$/i.test(await prompt.question(`${dir} is not empty. Remove its files and continue? (y/N) `)))

      if (!overwrite) {
        throw new Error(`${dir} is not empty; choose another directory or pass --overwrite`)
      }

      await emptyDir(dir)
    }

    let name = toValidPackageName(basename(resolve(dir)))

    if (prompt !== undefined) {
      const answer = (await prompt.question(`Package name (${name}): `)).trim()

      if (answer !== '' && !isValidPackageName(answer)) {
        throw new Error(`"${answer}" is not a valid npm package name`)
      }

      name = answer || name
    }

    await createProject({
      dir,
      name,
      coreVersion: args.coreVersion ?? readCoreVersion(),
      template: fileURLToPath(new URL('../template', import.meta.url)),
    })

    const manager = detectPackageManager(process.env.npm_config_user_agent)
    const cd = relative(process.cwd(), resolve(dir))

    stdout.write(`\nCreated ${name} in ${resolve(dir)}\n\nNext steps:\n`)

    if (cd !== '') {
      stdout.write(`  cd ${cd.includes(' ') ? JSON.stringify(cd) : cd}\n`)
    }

    stdout.write(`  ${manager} install\n  ${manager === 'npm' ? 'npm run' : manager} dev\n`)
  } finally {
    prompt?.close()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
