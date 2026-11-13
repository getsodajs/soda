/**
 * HTTP benchmark: the same three routes in Bun alone, Hono, Soda and Nest
 * (Express and Fastify adapters), each served by its own process and loaded
 * by oha (`brew install oha`). Scenarios are those of Hono's and SaltyAom's
 * benchmarks: a text response, a path parameter with a query and a header,
 * and a JSON echo.
 *
 *   bun run.ts [--duration=5] [--rounds=3] [--connections=100] [--only=soda,hono]
 *
 * Load generator and servers share the machine, so the numbers compare the
 * frameworks with each other, not with another machine. A laptop slows down
 * as it heats: every round measures every framework in turn, and each cell
 * is the median of its rounds. Each server is checked for the expected
 * responses, then warmed up, before being measured; only 200 responses count.
 */

import { cpus, totalmem } from 'node:os'
import { join } from 'node:path'

const argument = (name: string, fallback: string): string =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback

const DURATION = Number(argument('duration', '5'))
const ROUNDS = Number(argument('rounds', '3'))
const CONNECTIONS = Number(argument('connections', '100'))
const WARMUP = 3
const PORT = 4300
const ROOT = import.meta.dir

interface Framework {
  readonly name: string
  readonly command: readonly string[]
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
}

const FRAMEWORKS: readonly Framework[] = [
  { name: 'Bun (native routes)', command: ['bun', 'apps/bun.ts'], cwd: ROOT },
  { name: 'Hono', command: ['bun', 'apps/hono.ts'], cwd: ROOT },
  { name: 'Soda', command: ['bun', 'apps/soda.ts'], cwd: ROOT },
  // Run from their directory: Bun takes the tsconfig with legacy decorators from there.
  { name: 'Nest (Fastify)', command: ['bun', 'main.ts'], cwd: join(ROOT, 'apps/nest'), env: { ADAPTER: 'fastify' } },
  { name: 'Nest (Express)', command: ['bun', 'main.ts'], cwd: join(ROOT, 'apps/nest'), env: { ADAPTER: 'express' } },
]

interface Scenario {
  readonly name: string
  readonly path: string
  readonly args: readonly string[]
}

const BODY = '{"hello":"world","list":[1,2,3],"nested":{"a":true}}'

const SCENARIOS: readonly Scenario[] = [
  { name: 'GET /', path: '/', args: [] },
  { name: 'GET /id/:id?name=', path: '/id/42?name=bun', args: [] },
  { name: 'POST /json', path: '/json', args: ['-m', 'POST', '-T', 'application/json', '-d', BODY] },
]

const only = argument('only', '')
  .split(',')
  .filter((name) => name !== '')

const selected = FRAMEWORKS.filter(
  (framework) => only.length === 0 || only.some((name) => framework.name.toLowerCase().startsWith(name.toLowerCase()))
)

/** Waits until the server answers, for up to 10 seconds. */
const waitForServer = async (url: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fetch(url)

      return
    } catch {
      await Bun.sleep(100)
    }
  }

  throw new Error(`No server on ${url}`)
}

/** Every framework must give the same answers, or the comparison means nothing. */
const checkResponses = async (base: string, name: string): Promise<void> => {
  const text = await (await fetch(`${base}/`)).text()
  const id = await fetch(`${base}/id/42?name=bun`)
  const echo = await (await fetch(`${base}/json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: BODY })).json()
  const failures = [
    text === 'Hi' ? '' : `GET / gave ${JSON.stringify(text)}`,
    (await id.text()) === '42 bun' && id.headers.get('x-powered-by') === 'benchmark' ? '' : 'GET /id/:id is wrong',
    JSON.stringify(echo) === BODY ? '' : `POST /json gave ${JSON.stringify(echo)}`,
  ].filter((failure) => failure !== '')

  if (failures.length > 0) {
    throw new Error(`${name}: ${failures.join('; ')}`)
  }
}

interface OhaResult {
  readonly summary: { readonly total: number }
  readonly latencyPercentiles: { readonly p50: number; readonly p99: number }
  readonly statusCodeDistribution: Readonly<Record<string, number>>
}

/** Successful requests per second, and latencies in milliseconds. */
const load = async (url: string, scenario: Scenario, seconds: number) => {
  const oha = Bun.spawn(
    ['oha', '-z', `${seconds}s`, '-c', String(CONNECTIONS), '--no-tui', '--output-format', 'json', ...scenario.args, url],
    { stdout: 'pipe', stderr: 'pipe' }
  )
  const [output, code] = await Promise.all([new Response(oha.stdout).text(), oha.exited])

  if (code !== 0) {
    throw new Error(`oha failed: ${await new Response(oha.stderr).text()}`)
  }

  const result = JSON.parse(output) as OhaResult

  return {
    rps: (result.statusCodeDistribution['200'] ?? 0) / result.summary.total,
    p50: result.latencyPercentiles.p50 * 1000,
    p99: result.latencyPercentiles.p99 * 1000,
  }
}

type Measure = Awaited<ReturnType<typeof load>>

const measureFramework = async (framework: Framework): Promise<Measure[]> => {
  const server = Bun.spawn([...framework.command], {
    cwd: framework.cwd,
    env: { ...process.env, ...framework.env, PORT: String(PORT) },
    stdout: 'ignore',
    stderr: 'inherit',
  })
  const base = `http://127.0.0.1:${PORT}`

  try {
    await waitForServer(`${base}/`)
    await checkResponses(base, framework.name)

    const measures: Measure[] = []

    for (const scenario of SCENARIOS) {
      await load(`${base}${scenario.path}`, scenario, WARMUP)
      measures.push(await load(`${base}${scenario.path}`, scenario, DURATION))
    }

    return measures
  } finally {
    server.kill()
    await server.exited
  }
}

const format = (value: number): string => Math.round(value).toLocaleString('en-US')

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)

  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/** Measures of each framework, by round. */
const rounds = new Map<Framework, Measure[][]>(selected.map((framework) => [framework, []]))

for (let round = 1; round <= ROUNDS; round++) {
  for (const framework of selected) {
    process.stdout.write(`round ${round}/${ROUNDS}: ${framework.name}... `)
    rounds.get(framework)!.push(await measureFramework(framework))
    console.log('done')
  }
}

const results = selected.map((framework) => {
  const runs = rounds.get(framework)!
  const measures = SCENARIOS.map((_, index) => ({
    rps: median(runs.map((run) => run[index]!.rps)),
    p50: median(runs.map((run) => run[index]!.p50)),
    p99: median(runs.map((run) => run[index]!.p99)),
  }))

  return { framework, measures }
})

const baseline = results[0]!.measures
const lines = [
  `| Framework | ${SCENARIOS.map((scenario) => `${scenario.name} (req/s)`).join(' | ')} | Average | vs ${results[0]!.framework.name} |`,
  `|---|${SCENARIOS.map(() => '---:').join('|')}|---:|---:|`,
]

for (const { framework, measures } of results) {
  const average = measures.reduce((sum, measure) => sum + measure.rps, 0) / measures.length
  const baselineAverage = baseline.reduce((sum, measure) => sum + measure.rps, 0) / baseline.length

  lines.push(
    `| ${framework.name} | ${measures.map((measure) => `${format(measure.rps)} <sub>p99 ${measure.p99.toFixed(1)} ms</sub>`).join(' | ')} | ${format(average)} | ${((average / baselineAverage) * 100).toFixed(0)}% |`
  )
}

const versions = await Promise.all(
  ['hono', '@nestjs/core', '@getsoda/core'].map(async (name) => {
    const manifest = (await Bun.file(join(ROOT, 'node_modules', name, 'package.json')).json()) as { version: string }

    // The core is linked from this repository: its code may be newer than the version it carries.
    return name === '@getsoda/core' ? `${name} ${manifest.version} from this repository` : `${name} ${manifest.version}`
  })
)

const report = [
  `${cpus()[0]?.model ?? 'unknown CPU'}, ${cpus().length} cores, ${Math.round(totalmem() / 1024 ** 3)} GB; Bun ${Bun.version}; ${versions.join(', ')}.`,
  `oha, ${CONNECTIONS} connections, ${DURATION} s per scenario after ${WARMUP} s of warm-up; median of ${ROUNDS} rounds; successful responses only.`,
  '',
  ...lines,
].join('\n')

console.log(`\n${report}`)
await Bun.write(join(ROOT, 'RESULTS.md'), `# HTTP benchmark\n\n${report}\n`)
