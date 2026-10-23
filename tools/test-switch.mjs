/**
 * Tests for the provider switch, run against a COPY of the live profile patch.
 *
 * The point is to prove two things before this ever writes to the real file:
 * the edit is minimal (only the intended keys change) and the result is still
 * valid YAML. Structural self-checks alone are not enough for a file the whole
 * profile boots from.
 *
 *   node tools/test-switch.mjs [--patch <path to cordis.patch.yml>]
 */
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMode, describePatch, setEntryDisabled, setSearchProvider } from '../src/switch.js'
import { dshHome, loadFromHarness, profileDir } from './env.mjs'

const argv = process.argv.slice(2)
const option = (flag, fallback) => {
  const index = argv.indexOf(`--${flag}`)
  return index === -1 ? fallback : argv[index + 1]
}

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/**
 * Real YAML parsing, so a broken file cannot slip through.
 *
 * `createRequire` needs a FILE (or a file URL), never a directory — passing the
 * profile directory silently resolves nothing and the YAML checks then skip
 * themselves, which is a green result that verified nothing.
 */
function yamlLoader() {
  const yaml = loadFromHarness('js-yaml')
  return yaml === undefined ? undefined : (text) => yaml.load(text)
}
const parse = yamlLoader()

if (parse === undefined) {
  console.error('FALLO: no hay js-yaml disponible; no se puede validar el YAML.')
  process.exit(2)
}

const source = option('patch', join(profileDir('desktop'), 'cordis.patch.yml'))
const work = join(mkdtempSync(join(tmpdir(), 'wbridge-switch-')), 'cordis.patch.yml')
copyFileSync(source, work)
const original = readFileSync(work, 'utf-8')
console.log(`patch de prueba: ${work}`)
console.log(`validador YAML : js-yaml`)

console.log('== 1. estado de partida ==')
const before = describePatch(original)
console.log(`  ${JSON.stringify(before)}`)
check('encuentra la entrada web', before.hasWebBlock)

console.log('\n== 2. cambiar a bridge ==')
const bridgeText = applyMode(original, 'bridge')
const bridge = describePatch(bridgeText)
check('searchProvider = bridge', bridge.searchProvider === 'bridge', String(bridge.searchProvider))
check('proveedor oficial desactivado', bridge.officialDisabled === true, String(bridge.officialDisabled))
if (parse !== undefined) {
  let ok = false
  try {
    const doc = parse(bridgeText)
    ok = Array.isArray(doc)
  } catch (error) {
    ok = false
    console.log(`     error de YAML: ${error.message.slice(0, 90)}`)
  }
  check('el resultado sigue siendo YAML valido', ok)
}

console.log('\n== 3. la edicion es minima ==')
const beforeLines = original.split('\n')
const afterLines = bridgeText.split('\n')
const changed = []
for (let index = 0; index < Math.max(beforeLines.length, afterLines.length); index += 1) {
  if (beforeLines[index] !== afterLines[index]) changed.push({ index, from: beforeLines[index], to: afterLines[index] })
}
console.log(`  lineas distintas: ${changed.length}`)
for (const line of changed) console.log(`   ${line.index + 1}: ${JSON.stringify(line.from)} -> ${JSON.stringify(line.to)}`)
check('solo cambian las lineas buscadas', changed.length <= 2, `${changed.length} lineas`)

console.log('\n== 4. volver al oficial y de nuevo a bridge (ida y vuelta) ==')
const officialText = applyMode(bridgeText, 'official')
const official = describePatch(officialText)
check('searchProvider = deepseek-official', official.searchProvider === 'deepseek-official', String(official.searchProvider))
check('oficial reactivado', official.officialDisabled === false, String(official.officialDisabled))
const roundTrip = applyMode(officialText, 'bridge')
check('ida y vuelta estable', describePatch(roundTrip).searchProvider === 'bridge' && describePatch(roundTrip).officialDisabled === true)
if (parse !== undefined) {
  let ok = true
  try {
    parse(roundTrip)
  } catch {
    ok = false
  }
  check('tras ida y vuelta sigue siendo YAML valido', ok)
}

console.log('\n== 5. casos limite ==')
const noWeb = '- id: otra-cosa\n  config:\n    a: 1\n'
let threw = false
try {
  setSearchProvider(noWeb, 'bridge')
} catch {
  threw = true
}
check('sin entrada web falla claro, no adivina', threw)

const appended = setEntryDisabled('- id: web\n  config:\n    searchProvider: bridge\n', 'web-search-deepseek', true)
check('crea la entrada del oficial si no existe', /- id: web-search-deepseek\n\s+disabled: true/.test(appended), JSON.stringify(appended.slice(-60)))
if (parse !== undefined) {
  let ok = true
  try {
    parse(appended)
  } catch {
    ok = false
  }
  check('la entrada creada produce YAML valido', ok)
}

const failed = results.filter((entry) => entry.ok === false)
console.log(`\n== RESULTADO: ${results.length - failed.length}/${results.length} ==`)
for (const entry of failed) console.log(`  FAIL ${entry.label}`)
process.exit(failed.length === 0 ? 0 : 1)
