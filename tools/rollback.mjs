/**
 * Emergency rollback that does not need DSH, the plugin, or a restart.
 *
 * The switch (`/web-provider`, and the settings checkbox) lives inside the
 * plugin — so if the plugin is the thing that failed to load, the escape hatch
 * fails with it. This script is the way out: plain Node, no harness imports, it
 * only rewrites two keys of the profile patch, which the loader then applies
 * live.
 *
 *   node tools/rollback.mjs                 # back to the official provider
 *   node tools/rollback.mjs --mode bridge   # back to the bridge
 *   node tools/rollback.mjs --patch <file>  # operate on a copy (for testing)
 *   node tools/rollback.mjs --dry-run       # show what would change
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './env.mjs'
import { applyMode, describePatch, readPatch, writePatch } from '../src/switch.js'

const argv = process.argv.slice(2)
const option = (flag, fallback) => {
  const index = argv.indexOf(`--${flag}`)
  return index === -1 ? fallback : argv[index + 1]
}
const mode = option('mode', 'official')
const dryRun = argv.includes('--dry-run')
const explicit = option('patch', undefined)

const home = dshHome()
const profileDir = process.env.DSH_PROFILE_DIR ?? join(home, 'profiles', 'desktop')
const patchPath = explicit ?? join(profileDir, 'cordis.patch.yml')

if (mode !== 'official' && mode !== 'bridge') {
  console.error(`modo desconocido: ${mode} (usa official o bridge)`)
  process.exit(2)
}

console.log(`patch : ${patchPath}`)
try {
  const before = readPatch(patchPath)
  const previous = describePatch(before)
  console.log(`antes : searchProvider=${previous.searchProvider ?? '(sin fijar)'} fetchProvider=${previous.fetchProvider ?? '(sin fijar)'} oficialDesactivado=${previous.officialDisabled}`)

  const next = applyMode(before, mode)
  const after = describePatch(next)
  console.log(`despues: searchProvider=${after.searchProvider} fetchProvider=${after.fetchProvider} oficialDesactivado=${after.officialDisabled}`)

  if (dryRun === true) {
    console.log('\n--dry-run: no se escribio nada')
    process.exit(0)
  }

  const backup = writePatch(patchPath, next)
  const confirmed = describePatch(readFileSync(patchPath, 'utf-8'))
  const expected = mode === 'bridge' ? 'bridge' : 'deepseek-official'
  if (confirmed.searchProvider !== expected) {
    console.error(`\nFALLO: no se pudo confirmar. Respaldo en ${backup}`)
    process.exit(1)
  }
  console.log(`\nOK: seam apuntado a ${expected}. Respaldo: ${backup}`)
  console.log('El loader relee el patch en vivo: no hace falta reiniciar ni cargar el plugin.')
  if (mode === 'official') {
    console.log('Ojo: el proveedor oficial necesita saldo, o web_search devolvera HTTP 402.')
  }
  process.exit(0)
} catch (error) {
  console.error(`\nFALLO: ${String(error.message ?? error)}`)
  process.exit(1)
}
