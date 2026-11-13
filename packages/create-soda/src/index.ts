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
 * Asks questions in a terminal and takes flags otherwise (CI, scripts). The
 * build bundles `@clack/prompts`, so the published package has no
 * dependencies and runs the same under `npm create` (Node) and `bun create`.
 */

import * as prompts from '@clack/prompts'
import { spawn } from 'node:child_process'
import { basename, relative, resolve } from 'node:path'
import { stdin, stdout } from 'node:process'
import { fileURLToPath } from 'node:url'
import { styleText } from 'node:util'
import { version as coreVersion } from '../../core/package.json' with { type: 'json' }
import { version } from '../package.json' with { type: 'json' }
import {
  createProject,
  detectPackageManager,
  emptyDir,
  formatTargetDir,
  isEmptyDir,
  isValidPackageName,
  runScriptCommand,
  TEMPLATES,
  toValidPackageName,
} from './project.ts'

const DEFAULT_DIR = 'soda-app'

const HELP = `Usage: create-soda [directory] [options]

Creates a Soda project. Asks questions in a terminal.

Options:
  -t, --template <name>              template to use (default: ${TEMPLATES[0]!.name})
  --install, --no-install            install dependencies
  --overwrite                        empty the directory if it is not empty
  --interactive, --no-interactive    force or disable questions
  --core-version <range>             version of @getsoda/core to depend on
  -h, --help                         show this help

Templates:
${TEMPLATES.map((template) => `  ${template.name.padEnd(10)} ${template.hint}`).join('\n')}
`

interface Arguments {
  readonly dir: string | undefined
  readonly template: string | undefined
  readonly install: boolean | undefined
  readonly overwrite: boolean
  readonly interactive: boolean | undefined
  readonly coreVersion: string | undefined
  readonly help: boolean
}

const parseArguments = (args: readonly string[]): Arguments => {
  let dir: string | undefined
  let template: string | undefined
  let install: boolean | undefined
  let overwrite = false
  let interactive: boolean | undefined
  let coreVersion: string | undefined
  let help = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!

    if (arg === '-t' || arg === '--template') {
      template = args[++i]
    } else if (arg === '--install' || arg === '--no-install') {
      install = arg === '--install'
    } else if (arg === '--overwrite') {
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

  return { dir, template, install, overwrite, interactive, coreVersion, help }
}

/** Thrown when a question is cancelled with Ctrl+C or Escape. */
class Cancelled extends Error {}

/** The answer to a question, or {@link Cancelled}. */
const answer = async <T>(question: Promise<T | typeof prompts.CANCEL_SYMBOL>): Promise<T> => {
  const value = await question

  if (prompts.isCancel(value)) {
    throw new Cancelled()
  }

  return value
}

/** Runs a command in `cwd`, keeping its output to show when it fails. */
const run = (command: string, args: readonly string[], cwd: string): Promise<{ code: number; output: string }> =>
  new Promise((done, fail) => {
    // Package managers are `.cmd` scripts on Windows, which only a shell runs.
    const child = spawn(command, args, { cwd, shell: process.platform === 'win32' })
    let output = ''

    child.stdout.on('data', (chunk: Buffer) => (output += chunk))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk))
    child.on('error', fail)
    child.on('close', (code) => done({ code: code ?? 1, output }))
  })

const installDependencies = async (root: string, manager: string): Promise<void> => {
  const spinner = prompts.spinner()

  spinner.start(`Installing dependencies with ${manager}`)

  const { code, output } = await run(manager, ['install'], root)

  if (code !== 0) {
    spinner.error(`${manager} install failed`)
    process.stderr.write(output)

    throw new Error(`${manager} install exited with code ${code}`)
  }

  spinner.stop('Installed dependencies')
}

const main = async (): Promise<void> => {
  const args = parseArguments(process.argv.slice(2))

  if (args.help) {
    stdout.write(HELP)

    return
  }

  if (args.template !== undefined && !TEMPLATES.some((template) => template.name === args.template)) {
    throw new Error(`Unknown template "${args.template}"; use ${TEMPLATES.map((template) => template.name).join(' or ')}`)
  }

  const interactive = args.interactive ?? stdin.isTTY === true

  prompts.intro(`${styleText(['bgCyan', 'black'], ' create-soda ')} ${styleText('dim', `v${version}`)}`)

  let dir = formatTargetDir(args.dir ?? '')

  if (dir === '' && interactive) {
    const input = await answer(
      prompts.text({
        message: 'Project directory',
        placeholder: DEFAULT_DIR,
        defaultValue: DEFAULT_DIR,
        validate: (value) =>
          value === undefined || value === '' || formatTargetDir(value) !== '' ? undefined : 'Invalid directory name',
      }),
    )

    dir = formatTargetDir(input)
  }

  dir ||= DEFAULT_DIR

  // Asked now, done after the last question, so that a cancelled run leaves the directory as it was.
  const empty = await isEmptyDir(dir)
  const overwrite =
    !empty &&
    (args.overwrite ||
      (interactive &&
        (await answer(
          prompts.confirm({
            message: `${dir === '.' ? 'The current directory' : dir} is not empty. Remove its files and continue?`,
            initialValue: false,
          }),
        ))))

  if (!empty && !overwrite) {
    throw new Error(`${dir} is not empty; choose another directory or pass --overwrite`)
  }

  const root = resolve(dir)
  let name = basename(root)

  if (!isValidPackageName(name)) {
    const suggested = toValidPackageName(name)

    name = interactive
      ? await answer(
          prompts.text({
            message: 'Package name',
            placeholder: suggested,
            defaultValue: suggested,
            validate: (value) =>
              value === undefined || value === '' || isValidPackageName(value) ? undefined : 'Invalid package name',
          }),
        )
      : suggested
  }

  const template =
    args.template ??
    (interactive
      ? await answer(
          prompts.select({
            message: 'Template',
            options: TEMPLATES.map((option) => ({ value: option.name, label: option.label, hint: option.hint })),
          }),
        )
      : TEMPLATES[0]!.name)

  const manager = detectPackageManager(process.env.npm_config_user_agent)
  const install =
    args.install ?? (interactive && (await answer(prompts.confirm({ message: `Install dependencies with ${manager}?` }))))

  if (overwrite) {
    await emptyDir(dir)
  }

  await createProject({
    dir,
    name,
    coreVersion: args.coreVersion ?? `^${coreVersion}`,
    template: fileURLToPath(new URL(`../templates/${template}`, import.meta.url)),
  })

  prompts.log.success(`Created ${name} in ${root}`)

  if (install) {
    await installDependencies(root, manager)
  }

  const cd = relative(process.cwd(), root)
  const steps = [
    ...(cd === '' ? [] : [`cd ${cd.includes(' ') ? JSON.stringify(cd) : cd}`]),
    ...(install ? [] : [`${manager} install`]),
    runScriptCommand(manager, 'dev'),
  ]

  prompts.note(steps.join('\n'), 'Next steps')
  prompts.outro(`Docs: ${styleText('underline', 'https://github.com/getsodajs/soda')}`)
}

main().catch((error: unknown) => {
  if (error instanceof Cancelled) {
    prompts.cancel('Cancelled')
  } else {
    prompts.cancel(error instanceof Error ? error.message : String(error), { output: process.stderr })
  }

  process.exit(1)
})
