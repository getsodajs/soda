#!/usr/bin/env bun
/**
 * @module
 * The `soda` command.
 *
 * ```bash
 * soda check                # checks the application started by src/main.ts
 * soda check src/worker.ts  # another entry
 * soda check --json         # the report as JSON, for tools and agents
 * ```
 *
 * `soda check` runs the entry with `createApp()` in check mode: instead of
 * starting, it reports what would stop the application from starting, every
 * problem at once, and the command exits with 1 if there is any. Nothing
 * listens, no `onInit` runs, no factory opens a connection.
 */

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CHECK_HOOK, problemOf } from '../app/check.ts'
import type { CheckHook, CheckReport } from '../app/check.ts'
import { colors, PLAIN } from '../logger/palette.ts'
import { drawReport } from './format.ts'

const USAGE = `Usage: soda check [entry] [--json]

  entry   the file creating the application, src/main.ts by default
  --json  writes the report as JSON
`

const [command, ...args] = process.argv.slice(2)

if (command !== 'check') {
  process.stderr.write(USAGE)
  process.exit(command === undefined || command === '--help' || command === '-h' ? 0 : 2)
}

const json = args.includes('--json')
const entry = resolve(args.find((arg) => !arg.startsWith('-')) ?? 'src/main.ts')
const palette = process.stdout.isTTY === true && process.env.NO_COLOR === undefined ? colors() : PLAIN

const finish = (report: CheckReport): never => {
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${drawReport(report, palette)}\n`)
  process.exit(report.ok ? 0 : 1)
}

const started = performance.now()
const failed = (error: unknown): CheckReport => ({
  ok: false,
  problems: [problemOf(error)],
  duration: performance.now() - started,
  modules: 0,
  providers: 0,
  routes: 0,
})

let called = false

;(globalThis as Record<symbol, CheckHook>)[CHECK_HOOK] = (report) => {
  called = true
  void report.then(finish)
}

try {
  await import(pathToFileURL(entry).href)
} catch (error) {
  finish(failed(error))
}

if (!called) {
  finish(failed(new Error(`${entry} did not call createApp(): soda check runs the file that creates the application`)))
}
