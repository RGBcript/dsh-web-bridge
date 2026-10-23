// Package the plugin into dist/dsh-web-bridge-<version>.tgz.
//
// Same reasoning as the sibling plugins: a `file:` dependency on a versioned
// archive survives `pnpm install`, and what the profile runs is a frozen,
// auditable copy of a known version.
//
//   node tools/pack.mjs

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
const staged = join(root, '.pack')
const outDir = join(root, 'dist')
const outPath = join(outDir, `${pkg.name}-${pkg.version}.tgz`)

rmSync(staged, { recursive: true, force: true })
mkdirSync(join(staged, 'package'), { recursive: true })

/** Copy one entry (file or directory) into the staging tree. */
function stage(relativePath) {
  const source = join(root, relativePath)
  const stat = statSync(source, { throwIfNoEntry: false })
  if (stat === undefined) throw new Error(`package.json "files" names a missing path: ${relativePath}`)
  if (stat.isFile()) {
    copyFileSync(source, join(staged, 'package', relativePath))
    return 1
  }
  let count = 0
  mkdirSync(join(staged, 'package', relativePath), { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    count += stage(join(relativePath, entry.name))
  }
  return count
}

let fileCount = 0
for (const entry of ['package.json', ...(pkg.files ?? ['src'])]) fileCount += stage(entry)

mkdirSync(outDir, { recursive: true })
rmSync(outPath, { force: true })

try {
  execFileSync('tar', ['-czf', outPath, '-C', staged, 'package'], { stdio: 'inherit' })
} catch (error) {
  throw new Error(`tar failed (${error.message}); the archive was not written`)
}

rmSync(staged, { recursive: true, force: true })

console.log(`packed ${outPath}`)
console.log(`files:  ${fileCount}`)
console.log(`bytes:  ${statSync(outPath).size}`)
console.log(`sha256: ${createHash('sha256').update(readFileSync(outPath)).digest('hex')}`)
