#!/usr/bin/env bun
/**
 * @module
 * The `soda` command.
 *
 * ```bash
 * soda check                # what would stop the application of src/main.ts from starting
 * soda check src/worker.ts  # another entry
 * soda inspect              # its modules, providers and routes
 * soda check --json         # either report as JSON, for tools and agents
 * ```
 *
 * Both run the entry with `createApp()` dry: instead of starting, it hands
 * the application over to be checked or described. Nothing listens, no
 * `onInit` runs, no factory opens a connection. `check` exits with 1 when
 * there is a problem.
 */

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CHECK_HOOK, problemOf } from '../app/check.ts'
import type { CheckedApp, CheckHook, CheckProblem, CheckReport } from '../app/check.ts'
import type { InspectReport } from '../app/inspect.ts'
import { colors, PLAIN } from '../logger/palette.ts'
import { drawInspect, drawReport } from './format.ts'

const USAGE = `Usage: soda <command> [entry] [--json]

  check    what would stop the application from starting, every problem at once
  inspect  the modules, what each provider injects, the routes

  entry    the file creating the application, src/main.ts by default
  --json   writes the report as JSON
`

const COMMANDS = ['check', 'inspect'] as const

type Command = (typeof COMMANDS)[number]

const [name, ...args] = process.argv.slice(2)

if (!COMMANDS.includes(name as Command)) {
  process.stderr.write(USAGE)
  process.exit(name === undefined || name === '--help' || name === '-h' ? 0 : 2)
}

const command = name as Command
const json = args.includes('--json')
const entry = resolve(args.find((arg) => !arg.startsWith('-')) ?? 'src/main.ts')
const palette = process.stdout.isTTY === true && process.env.NO_COLOR === undefined ? colors() : PLAIN
const started = performance.now()

const write = (report: CheckReport | InspectReport): never => {
  const human = command === 'inspect' ? drawInspect(report as InspectReport, palette) : drawReport(report as CheckReport, palette)

  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${human}\n`)

  return process.exit(report.ok || command === 'inspect' ? 0 : 1)
}

/** An entry failing before handing the application over: a problem, whatever the command. */
const failed = (problem: CheckProblem): never => {
  const report: CheckReport = { ok: false, problems: [problem], duration: performance.now() - started, modules: 0, providers: 0, routes: 0 }

  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${drawReport(report, palette)}\n`)

  return process.exit(1)
}

let handed = false

;(globalThis as Record<symbol, CheckHook>)[CHECK_HOOK] = (app: CheckedApp) => {
  handed = true
  void app[command]().then(write, (error: unknown) => failed(problemOf(error)))
}

try {
  await import(pathToFileURL(entry).href)
} catch (error) {
  failed(problemOf(error))
}

if (!handed) {
  failed(problemOf(new Error(`${entry} did not call createApp(): soda ${command} runs the file that creates the application`)))
}
