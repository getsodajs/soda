import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectPackageManager, runScriptCommand, TEMPLATES, toValidPackageName } from './project.ts'

const PACKAGE = join(import.meta.dir, '..')
const CORE = join(PACKAGE, '..', 'core')
const directory = await mkdtemp(join(tmpdir(), 'create-soda-'))

afterAll(() => rm(directory, { recursive: true, force: true }))

/** Runs the CLI from its sources without a terminal, as in CI. */
const create = async (args: readonly string[]) => {
  const child = Bun.spawn(['bun', join(PACKAGE, 'src', 'index.ts'), ...args], {
    cwd: directory,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  return { stdout, stderr, code }
}

const run = async (cwd: string, command: readonly string[]) => {
  const child = Bun.spawn([...command], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  return { output: stdout + stderr, code }
}

describe('create-soda', () => {
  it('creates a minimal project named after its directory, depending on the current core', async () => {
    const { code, stdout } = await create(['my-app'])
    const root = join(directory, 'my-app')
    const manifest = (await Bun.file(join(root, 'package.json')).json()) as {
      name: string
      dependencies: Record<string, string>
    }
    const core = (await Bun.file(join(CORE, 'package.json')).json()) as { version: string }

    expect(code).toBe(0)
    expect(manifest.name).toBe('my-app')
    expect(manifest.dependencies['@getsoda/core']).toBe(`^${core.version}`)
    expect(existsSync(join(root, '.gitignore'))).toBe(true)
    expect(existsSync(join(root, '_gitignore'))).toBe(false)
    expect(existsSync(join(root, '.oxlintrc.json'))).toBe(true)
    expect(existsSync(join(root, 'src', 'app.controller.ts'))).toBe(true)
    expect(existsSync(join(root, 'src', 'users'))).toBe(false)
    expect(stdout).toContain('cd my-app')
    expect(stdout).toContain('bun install')
  })

  it('creates the demo with --template, and refuses unknown templates', async () => {
    const demo = await create(['demo-app', '--template', 'demo'])
    const unknown = await create(['other-app', '-t', 'nope'])

    expect(demo.code).toBe(0)
    expect(existsSync(join(directory, 'demo-app', 'src', 'users', 'users.controller.ts'))).toBe(true)
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('Unknown template "nope"; use minimal or demo')
    expect(existsSync(join(directory, 'other-app'))).toBe(false)
  })

  it('makes the package name valid for npm', async () => {
    await create(['My Big App'])

    const manifest = (await Bun.file(join(directory, 'My Big App', 'package.json')).json()) as { name: string }

    expect(manifest.name).toBe('my-big-app')
    expect(toValidPackageName('  _Weird Name!! ')).toBe('weird-name-')
  })

  it('refuses a non-empty directory unless told to overwrite it, and keeps .git', async () => {
    const root = join(directory, 'taken')

    await mkdir(join(root, '.git'), { recursive: true })
    await writeFile(join(root, 'notes.txt'), 'mine')

    const refused = await create(['taken'])

    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('taken is not empty; choose another directory or pass --overwrite')
    expect(existsSync(join(root, 'notes.txt'))).toBe(true)

    const overwritten = await create(['taken', '--overwrite'])
    const entries = await readdir(root)

    expect(overwritten.code).toBe(0)
    expect(entries).toContain('.git')
    expect(entries).not.toContain('notes.txt')
  })

  it('reads the package manager from the user agent', () => {
    expect(detectPackageManager('bun/1.4.3 npm/? node/v24.0.0 darwin arm64')).toBe('bun')
    expect(detectPackageManager('npm/11.6.0 node/v24.0.0 darwin arm64 workspaces/false')).toBe('npm')
    expect(detectPackageManager(undefined)).toBe('bun')
    expect(runScriptCommand('npm', 'dev')).toBe('npm run dev')
    expect(runScriptCommand('bun', 'dev')).toBe('bun dev')
  })
})

// The projects depend on the core of this repository, built as it would be published.
beforeAll(async () => {
  expect((await run(CORE, ['bun', 'run', 'build'])).code).toBe(0)
}, 60_000)

/** Tests each generated project passes, by template. */
const PASSING: Readonly<Record<string, number>> = { minimal: 1, demo: 2 }

describe.each(TEMPLATES.map((template) => template.name))('generated %s project', (template) => {
  const root = join(directory, `e2e-${template}`)

  beforeAll(async () => {
    const created = await create([
      `e2e-${template}`,
      '--template',
      template,
      '--install',
      '--core-version',
      `file:${CORE}`,
    ])

    expect(created.code, created.stdout + created.stderr).toBe(0)
    expect(created.stdout).toContain('Installed dependencies')
    expect(created.stdout).not.toContain('bun install')
  }, 180_000)

  it('passes its own tests', async () => {
    const result = await run(root, ['bun', 'test'])

    expect(result.code, result.output).toBe(0)
    expect(result.output).toContain(`${PASSING[template]} pass`)
  }, 60_000)

  it('passes its own type check', async () => {
    const result = await run(root, ['bun', 'run', 'typecheck'])

    expect(result.code, result.output).toBe(0)
  }, 60_000)

  it('passes its own lint', async () => {
    // Warnings fail too: a new project must be clean.
    const result = await run(root, ['bun', 'run', 'lint', '--deny-warnings'])

    expect(result.code, result.output).toBe(0)
  }, 60_000)

  it('builds a bundle that serves requests', async () => {
    expect((await run(root, ['bun', 'run', 'build'])).code).toBe(0)

    const server = Bun.spawn(['bun', 'dist/main.js'], { cwd: root, env: { ...process.env, PORT: '0' }, stdout: 'pipe' })

    try {
      const decoder = new TextDecoder()
      let output = ''

      for await (const chunk of server.stdout) {
        output += decoder.decode(chunk, { stream: true })

        if (output.includes('Listening on')) {
          break
        }
      }

      const url = /Listening on (\S+)/.exec(output)?.[1]

      expect(url).toBeDefined()
      expect((await fetch(new URL(template === 'demo' ? '/users' : '/', url))).status).toBe(200)
    } finally {
      server.kill()
    }
  }, 60_000)
})
