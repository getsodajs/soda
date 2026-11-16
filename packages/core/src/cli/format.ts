/**
 * @module
 * How `soda check` and `soda inspect` write their reports for people: each problem with the line
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
import type { InspectDependency, InspectModule, InspectReport, InspectRoute } from '../app/inspect.ts'
import type { Palette } from '../logger/palette.ts'
import { drawRoutes } from '../logger/startup.ts'

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

/** `query page, full`, `header x-key`, then `body` or `form`, as the startup summary writes them. */
const inputsOf = (route: InspectRoute): string[] => {
  if (route.events !== undefined) {
    return route.events.length > 0 ? [route.events.join(', ')] : []
  }

  const named = new Map<string, string[]>()
  const whole: string[] = []

  for (const input of route.inputs) {
    if (input.kind === 'query' || input.kind === 'header' || input.kind === 'cookie') {
      named.set(input.kind, [...(named.get(input.kind) ?? []), input.name ?? ''])
    } else if (input.kind === 'body' || input.kind === 'form') {
      whole.push(input.kind)
    }
  }

  return [...[...named].map(([kind, names]) => `${kind} ${names.join(', ')}`), ...whole]
}

const drawDependency = (dependency: InspectDependency, module: string, palette: Palette): string => {
  const token = dependency.optional ? `${dependency.token}?` : dependency.token

  if (dependency.from === undefined) {
    return dependency.optional ? palette.dim(token) : `${palette.coral(token)} ${palette.coral('✖')}`
  }

  return dependency.from === module ? token : `${token} ${palette.dim(`(${dependency.from})`)}`
}

const drawModule = (module: InspectModule, palette: Palette): string[] => {
  const { bold, dim, aqua } = palette
  const facts = [module.global ? palette.violet('global') : '']

  if (module.imports.length > 0) {
    facts.push(`${dim('imports')} ${module.imports.join(dim(', '))}`)
  }

  if (module.exports.length > 0) {
    facts.push(`${dim('exports')} ${module.exports.join(dim(', '))}`)
  }

  const lines = [`${INDENT}${bold(module.name)}  ${facts.filter((fact) => fact !== '').join('  ')}`.trimEnd()]
  const members = [...module.providers, ...module.controllers]
  const width = Math.max(0, ...members.map((member) => member.token.length))

  for (const member of members) {
    const kind = member.kind === 'class' ? '' : dim(member.kind)
    const scope = member.scope === 'transient' ? aqua('transient') : ''
    const injects = member.injects.length === 0 ? '' : `${dim('→')} ${member.injects.map((dependency) => drawDependency(dependency, module.name, palette)).join(dim(', '))}`
    const details = [kind, scope, injects].filter((detail) => detail !== '').join('  ')

    lines.push(`${INDENT}  ${member.token.padEnd(width)}  ${details}`.trimEnd())
  }

  return lines
}

export const drawInspect = (report: InspectReport, palette: Palette): string => {
  const { bold, dim, lime, coral } = palette
  const providers = report.modules.reduce((total, module) => total + module.providers.length, 0)
  const figures = [count(report.modules.length, 'module'), count(providers, 'provider'), count(report.routes.length, 'route')].join(dim(' · '))
  const lines = ['', `${INDENT}${bold(lime('soda'))} inspect  ${figures}  ${dim(`${Math.round(report.duration)} ms`)}`]

  for (const module of report.modules) {
    lines.push('', ...drawModule(module, palette))
  }

  const routes = report.routes.map((route) => ({ ...route, inputs: inputsOf(route), sse: route.sse === true }))

  if (routes.length > 0) {
    lines.push('', ...drawRoutes(routes, palette))
  }

  if (!report.ok) {
    lines.push('', `${INDENT}${coral(count(report.problems.length, 'problem'))}: ${dim('soda check')} tells what and where`)
  }

  lines.push('')

  return lines.join('\n')
}
