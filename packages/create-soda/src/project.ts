/**
 * @module
 * Creating a project from the template: names, target directory, files.
 *
 * Rules from `create-vite`: the target directory is cleaned of characters
 * file systems refuse, a directory holding only `.git` counts as empty, the
 * package name is made valid for npm, and `.gitignore` is stored as
 * `_gitignore` because npm drops `.gitignore` files from published packages.
 */

import { existsSync } from 'node:fs'
import { cp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

/** Template files renamed when copied. */
const RENAMED: Readonly<Record<string, string>> = { _gitignore: '.gitignore' }

/** `' my-app/ '` → `'my-app'`. */
export const formatTargetDir = (dir: string): string =>
  dir
    .trim()
    .replace(/[<>:"\\|?*]/g, '')
    .replace(/\/+$/, '')

export const isValidPackageName = (name: string): boolean =>
  /^(?:@[a-z\d\-*~][a-z\d\-*._~]*\/)?[a-z\d\-~][a-z\d\-._~]*$/.test(name)

/** `'My App'` → `'my-app'`. */
export const toValidPackageName = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/^[._]/, '')
    .replace(/[^a-z\d\-~]+/g, '-')

/** `true` for a missing directory, an empty one, or one holding only `.git`. */
export const isEmptyDir = async (dir: string): Promise<boolean> => {
  if (!existsSync(dir)) {
    return true
  }

  const entries = await readdir(dir)

  return entries.length === 0 || (entries.length === 1 && entries[0] === '.git')
}

/** Removes everything in `dir` but `.git`. */
export const emptyDir = async (dir: string): Promise<void> => {
  for (const entry of await readdir(dir)) {
    if (entry !== '.git') {
      await rm(join(dir, entry), { recursive: true, force: true })
    }
  }
}

export interface ProjectOptions {
  /** Directory to create the project in. */
  readonly dir: string
  /** Package name; defaults to a valid name built from the directory name. */
  readonly name?: string
  /** Version range of `@getsoda/core` the project depends on. */
  readonly coreVersion: string
  /** Template directory. */
  readonly template: string
}

/**
 * Copies the template into `dir`, renames `_gitignore`, sets the package name and the core version.
 */
export const createProject = async (options: ProjectOptions): Promise<void> => {
  const root = resolve(options.dir)

  await cp(options.template, root, { recursive: true })

  for (const [from, to] of Object.entries(RENAMED)) {
    if (existsSync(join(root, from))) {
      await rename(join(root, from), join(root, to))
    }
  }

  const manifestPath = join(root, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    name: string
    dependencies: Record<string, string>
  }

  manifest.name = options.name ?? toValidPackageName(basename(root))
  manifest.dependencies['@getsoda/core'] = options.coreVersion
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

/**
 * Package manager the command was run with, from `npm_config_user_agent`
 * (`bun/1.4.3 npm/? node/v24…` → `bun`). Defaults to `bun`.
 */
export const detectPackageManager = (userAgent: string | undefined): string => {
  const name = userAgent?.split(' ')[0]?.split('/')[0]

  return name === undefined || name === '' ? 'bun' : name
}
