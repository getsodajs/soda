/**
 * @module
 * How `soda check` writes its report for people: each problem with the line
 * of code it points to and how to fix it.
 *
 * ```
 *   soda check  1 problem  38 ms
 *
 *   ✖ NO_PROVIDER  No provider for UsersRepository in UsersModule (UsersService → UsersRepository).
 *     src/users/users.service.ts:4:24
 *        4 │   readonly #repository = inject(UsersRepository)
 *          │                          ^
 *     fix  DatabaseModule provides it but does not export it: add it to the exports of DatabaseModule.
 * ```
 */

import { readFileSync } from 'node:fs'
import type { CheckProblem, CheckReport } from '../app/check.ts'
import type { Palette } from '../logger/palette.ts'

const INDENT = '  '

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

/** The line `problem` points to, with its number and a caret under the column. */
const codeFrame = (problem: CheckProblem, palette: Palette): string[] => {
  if (problem.file === undefined || problem.line === undefined) {
    return []
  }

  let source: string | undefined

  try {
    source = readFileSync(problem.file, 'utf8').split('\n')[problem.line - 1]
  } catch {
    return []
  }

  if (source === undefined) {
    return []
  }

  const number = String(problem.line)
  const gutter = ' '.repeat(number.length)
  const code = source.replaceAll('\t', '  ')
  const caret = `${' '.repeat(Math.max(0, (problem.column ?? 1) - 1))}^`

  return [
    `${INDENT}   ${palette.dim(`${number} │`)} ${code}`,
    `${INDENT}   ${palette.dim(`${gutter} │`)} ${palette.coral(caret)}`,
  ]
}

const drawProblem = (problem: CheckProblem, palette: Palette): string[] => {
  const [first, ...rest] = problem.message.split('\n')
  const lines = [`${INDENT}${palette.coral('✖')} ${palette.bold(problem.code)}  ${first}`]

  for (const line of rest) {
    lines.push(`${INDENT}  ${line}`)
  }

  if (problem.file !== undefined) {
    lines.push(`${INDENT}  ${palette.aqua(`${problem.file}:${problem.line}:${problem.column}`)}`)
    lines.push(...codeFrame(problem, palette))
  }

  if (problem.fix !== undefined) {
    lines.push(`${INDENT}  ${palette.lime('fix')}  ${problem.fix}`)
  }

  return lines
}

export const drawReport = (report: CheckReport, palette: Palette): string => {
  const { bold, dim, lime, coral } = palette
  const time = dim(`${Math.round(report.duration)} ms`)

  if (report.ok) {
    const figures = [count(report.modules, 'module'), count(report.providers, 'provider'), count(report.routes, 'route')].join(dim(' · '))

    return `\n${INDENT}${bold(lime('soda'))} check  ${lime('✔ ok')}  ${figures}  ${time}\n`
  }

  const lines = ['', `${INDENT}${bold(lime('soda'))} check  ${coral(count(report.problems.length, 'problem'))}  ${time}`]

  for (const problem of report.problems) {
    lines.push('', ...drawProblem(problem, palette))
  }

  lines.push('')

  return lines.join('\n')
}
