import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectPackageManager, toValidPackageName } from './project.ts'

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
  it('creates a project named after its directory, depending on the current core', async () => {
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
    expect(stdout).toContain('cd my-app')
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
  })
})

describe('generated project', () => {
  const root = join(directory, 'e2e-app')

  beforeAll(async () => {
    // The project depends on the core of this repository, built as it would be published.
    expect((await run(CORE, ['bun', 'run', 'build'])).code).toBe(0)
    expect((await create(['e2e-app', '--core-version', `file:${CORE}`])).code).toBe(0)

    const install = await run(root, ['bun', 'install'])

    expect(install.code, install.output).toBe(0)
  }, 180_000)

  it('passes its own tests', async () => {
    const result = await run(root, ['bun', 'test'])

    expect(result.code, result.output).toBe(0)
    expect(result.output).toContain('2 pass')
  }, 60_000)

  it('passes its own type check', async () => {
    const result = await run(root, ['bun', 'run', 'typecheck'])

    expect(result.code, result.output).toBe(0)
  }, 60_000)
})
