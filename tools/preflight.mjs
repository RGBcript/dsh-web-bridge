/**
 * Preflight for a real profile: everything that must be true BEFORE a restart
 * trusts this plugin with `web_search`.
 *
 * The failure this prevents: a pin applied live to a host whose plugin could not
 * import yet, leaving search dead for twenty minutes. Run this before and after
 * a restart — it answers "is the seam pointing at a provider that exists?" with
 * facts on disk instead of hope.
 *
 *   node tools/preflight.mjs [--profile desktop] [--home <DSH_HOME>]
 *
 * Exit code 0 when the profile is safe to run, 1 otherwise.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspect, loadSemver, runtimeVersion } from './env-doctor.mjs'
import { dshHome } from './env.mjs'
import { describePatch } from '../src/switch.js'

const argv = process.argv.slice(2)
const option = (flag, fallback) => {
  const index = argv.indexOf(`--${flag}`)
  return index === -1 ? fallback : argv[index + 1]
}
const profile = option('profile', 'desktop')
const home = dshHome(option('home', undefined))
const profileDir = join(home, 'profiles', profile)

const results = []
const add = (level, label, detail) => {
  results.push({ level, label })
  const tag = level === 'fail' ? 'FAIL' : level === 'warn' ? 'WARN' : 'PASS'
  console.log(`  ${tag} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

console.log(`preflight: profile=${profile}`)
console.log(`           dir=${profileDir}\n`)

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return undefined
  }
}

console.log('== plugin instalado ==')
const installedDir = join(profileDir, 'node_modules', 'dsh-web-bridge')
const installed = readJson(join(installedDir, 'package.json'))
if (installed === undefined) {
  add('fail', 'el plugin no esta instalado', installedDir)
} else {
  add('ok', `instalado v${installed.version}`)
  for (const file of ['src/index.js', 'src/switch.js', 'src/settings.js', 'cordis.patch.yml']) {
    add(readJson(join(installedDir, 'package.json')) !== undefined && fileExists(join(installedDir, file)) ? 'ok' : 'fail', file)
  }
}

function fileExists(path) {
  try {
    readFileSync(path)
    return true
  } catch {
    return false
  }
}

/*
 * El gate que faltaba. El gestor de plugins veta un plugin incompatible con un
 * badge «Problema» y NO lo activa; fuera de Electron ese gate no se ejecuta, asi
 * que todo lo anterior puede dar verde mientras el plugin esta vetado. Sin esta
 * comprobacion, el preflight mentia.
 */
console.log('\n== compatible con el runtime (gate del gestor) ==')
if (installed !== undefined) {
  const runtime = runtimeVersion()
  const semver = loadSemver()
  if (runtime === undefined || semver === undefined) {
    add('warn', 'no se pudo determinar el runtime o cargar semver', 'gate no evaluado')
  } else {
    const [verdict] = inspect([{ label: installed.name, path: join(installedDir, 'package.json'), manifest: installed }], runtime.version, semver)
    add(verdict.ok ? 'ok' : 'fail', `runtime ${runtime.version}`, verdict.ok ? 'sin requisitos incumplidos' : 'EL GESTOR LO VETARA')
    if (!verdict.ok) {
      for (const [key, range] of Object.entries(verdict.unmet)) {
        add('fail', `${key}: "${range}" no satisface ${runtime.version}`, verdict.verdict.slice(0, 90))
      }
      if (verdict.exemption !== undefined) console.log(`       o: ${verdict.exemption}`)
    }
  }
}

console.log('\n== registrado como bundle ==')
const profilePkg = readJson(join(profileDir, 'package.json'))
const bundles = Array.isArray(profilePkg?.dsh?.profile?.bundles) ? profilePkg.dsh.profile.bundles : []
/*
 * Dos formas validas de montar el plugin, y el preflight debe aceptar ambas:
 *  - como bundle (su propio cordis.patch.yml), o
 *  - dentro de un bloque `insert` del patch del perfil.
 * Una entrada suelta `- id: X` de nivel superior NO crea nada: solo parchea una
 * entrada que ya existe. Comprobado a base de reinicios.
 */
const declaredPatch = (() => {
  try {
    return readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf-8')
  } catch {
    return ''
  }
})()
const asBundle = bundles.includes('dsh-web-bridge')
const asInsert = /(?:^|\n)\s*- id:\s*web-bridge\s*(?:\n|$)/.test(declaredPatch)
add(
  asBundle || asInsert ? 'ok' : 'fail',
  'entrada declarada',
  asBundle ? 'como bundle' : asInsert ? 'en un bloque insert del patch de perfil' : 'en ningun sitio',
)
const dependency = profilePkg?.dependencies?.['dsh-web-bridge']
add(typeof dependency === 'string' ? 'ok' : 'fail', 'declarado en dependencies', String(dependency))

console.log('\n== seam apuntado a un proveedor que existe ==')
const patchText = (() => {
  try {
    return readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf-8')
  } catch {
    return undefined
  }
})()
if (patchText === undefined) {
  add('fail', 'no se puede leer cordis.patch.yml')
} else {
  const state = describePatch(patchText)
  add('ok', 'searchProvider actual', String(state.searchProvider ?? '(sin fijar)'))
  add('ok', 'fetchProvider actual', String(state.fetchProvider ?? '(sin fijar)'))
  add(
    state.officialDisabled === true ? 'ok' : 'warn',
    'proveedor oficial desactivado',
    state.officialDisabled === true ? 'si' : 'no (si esta sin saldo, web_search devolvera 402)',
  )
  // The dangerous combination: pinned to the bridge while the bridge cannot load.
  const pinnedBridge = state.searchProvider === 'bridge'
  if (pinnedBridge && installed === undefined) {
    add('fail', 'pin a bridge SIN plugin instalado', 'web_search quedaria muerto')
  } else if (pinnedBridge) {
    add('ok', 'pin a bridge con plugin instalado', 'coherente')
  }
  if (state.fetchProvider === undefined || state.fetchProvider === '') {
    add('warn', 'fetchProvider sin fijar', 'con dos proveedores de fetch usables, web_fetch falla por ambiguedad')
  }
}

console.log('\n== el modulo se evalua en el perfil real ==')
if (installed !== undefined) {
  const work = mkdtempSync(join(tmpdir(), 'wbridge-preflight-'))
  try {
    // Resolve from a directory that contains the profile's node_modules, so a
    // missing peer fails here instead of during boot.
    const entry = pathToFileURL(join(installedDir, 'src', 'index.js')).href
    const module = await import(entry)
    add(typeof module.apply === 'function' ? 'ok' : 'fail', 'exporta apply')
    add(module.Config === undefined ? 'warn' : 'ok', 'exporta Config', module.Config === undefined ? 'sin esquema: no habra formulario de ajustes' : 'presente')
    add(module.default?.Config !== undefined ? 'ok' : 'warn', 'default.Config presente', module.default?.Config === undefined ? 'el loader no vera el esquema' : 'ok')
    const useBridge = module.Config === undefined ? 'n/a' : 'declarado en el esquema'
    add('ok', 'campo useBridge (checkbox)', useBridge)
    void createRequire(join(profileDir, 'noop.js'))
  } catch (error) {
    add('fail', 'el modulo no se evalua', String(error.message).slice(0, 120))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

console.log('\n== ultimo arranque (boot.json) ==')
const boot = readJson(join(home, 'web-bridge', 'boot.json'))
if (boot === undefined) {
  add('warn', 'sin boot.json', 'el plugin no ha arrancado todavia en este home (o es la primera vez)')
} else {
  add(boot.stage === 'registered' ? 'ok' : 'fail', 'ultima etapa', String(boot.stage))
  if (boot.at !== undefined) add('ok', 'cuando', String(boot.at))
  if (boot.error !== undefined) add('fail', 'error reportado', String(boot.error).slice(0, 140))
  if (boot.attempt !== undefined) add('ok', 'intento de registro', String(boot.attempt))
}

const failures = results.filter((entry) => entry.level === 'fail')
const warnings = results.filter((entry) => entry.level === 'warn')
console.log(`\n== RESUMEN: ${results.length - failures.length - warnings.length} ok, ${warnings.length} warn, ${failures.length} fail ==`)
for (const entry of failures) console.log(`  FAIL ${entry.label}`)
for (const entry of warnings) console.log(`  WARN ${entry.label}`)
process.exit(failures.length === 0 ? 0 : 1)
