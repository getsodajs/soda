/**
 * Sets the version of every package: `bun run release:version 0.2.0`.
 * The packages are released together and share one version.
 */

const PACKAGES = ['packages/core', 'packages/create-soda']
const version = process.argv[2]

if (version === undefined || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
  console.error('Usage: bun run release:version <x.y.z>')
  process.exit(1)
}

for (const directory of PACKAGES) {
  const path = `${directory}/package.json`
  const manifest = (await Bun.file(path).json()) as { version: string }

  manifest.version = version
  await Bun.write(path, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`${path}: ${version}`)
}

// What the startup summary shows.
await Bun.write('packages/core/src/version.ts', `/** Version of \`@getsoda/core\`, set by \`bun run release:version\`. */\nexport const VERSION = '${version}'\n`)
console.log(`packages/core/src/version.ts: ${version}`)

console.log(`\nNext: git commit -am "chore: release ${version}" && git tag -a v${version} -m v${version} && git push --follow-tags`)
