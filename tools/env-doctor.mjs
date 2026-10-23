#!/usr/bin/env node
/**
 * Diagnóstico del entorno DSH para plugins.
 *
 * Existe porque `--dump-config` da un verde falso: el gate de compatibilidad vive
 * en el gestor de plugins, que está desactivado fuera de Electron. Un plugin con
 * un peer incompatible se ve perfectamente instalado, con su patch compuesto y
 * su módulo importable... y el gestor lo veta con un badge «Problema» que ningún
 * comando de terminal reproduce.
 *
 * Emula `evaluatePluginCompatibility` del host:
 *   - la versión del runtime se lee del asar (`release.version`), que es la
 *     fuente autoritativa, no del CLI npm (puede ser una copia más vieja);
 *   - `engines.dsh` decide SOLO e ignora los peers;
 *   - si no hay `engines.dsh`, se vigilan solo los peers `@deepseek-ai/dsh`
 *     y `@deepseek-ai/dsh-*`;
 *   - `workspace:^|~|*` equivale a la versión del runtime;
 *   - los prereleases participan (`includePrerelease: true`).
 *
 * Uso:
 *   node tools/env-doctor.mjs                       # plugins del perfil desktop
 *   node tools/env-doctor.mjs --profile web
 *   node tools/env-doctor.mjs --plugin <ruta o nombre>
 *   node tools/env-doctor.mjs --json
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { appRoots, dshHome, harnessPackageRoots, loadFromHarness } from './env.mjs'

const WATCHED = (name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
const WORKSPACE_RANGES = new Set(['workspace:^', 'workspace:~', 'workspace:*'])

/** Candidatos donde vive el asar, del más al menos probable. */
function asarCandidates() {
  return appRoots().flatMap((root) => [join(root, 'app.asar'), join(root, 'dsh', 'package.json')])
}

/**
 * Versión del runtime.
 * Primero el `release.version` del asar, que es lo que lee el host; si no está,
 * el `package.json` del paquete dsh instalado.
 */
export function runtimeVersion() {
  for (const candidate of asarCandidates()) {
    if (!existsSync(candidate)) continue
    try {
      const text = readFileSync(candidate, 'utf-8')
      // El asar lleva una cabecera JSON con datos de la release.
      const match = text.match(/"release"\s*:\s*\{[^}]*?"version"\s*:\s*"([0-9][^"]*)"/)
      if (match !== null) return { version: match[1], source: candidate, kind: 'asar' }
      const parsed = JSON.parse(text)
      if (typeof parsed.version === 'string') return { version: parsed.version, source: candidate, kind: 'package.json' }
    } catch {
      // siguiente candidato
    }
  }
  return undefined
}

/** Carga `semver` desde la instalación del harness (fuera de dsh no resuelve). */
export function loadSemver() {
  return loadFromHarness('semver')
}

/**
 * Requisitos incumplidos, con la misma precedencia que el host.
 * @returns mapa de requisito→rango, o {} si todo se cumple.
 */
export function unmetRequirements(manifest, version, semver) {
  const satisfies = (range) => {
    const effective = WORKSPACE_RANGES.has(range) ? version : range
    if (typeof effective !== 'string' || effective.trim() === '') return false
    return semver.satisfies(version, effective, { includePrerelease: true })
  }

  // `engines.dsh` decide solo: si existe, los peers se ignoran por completo.
  if (manifest?.engines !== null && typeof manifest?.engines === 'object' && Object.hasOwn(manifest.engines, 'dsh')) {
    const range = manifest.engines.dsh
    return satisfies(range) ? {} : { 'engines.dsh': range }
  }

  const peers = manifest?.peerDependencies
  if (peers === null || typeof peers !== 'object') return {}
  const unmet = {}
  for (const [name, range] of Object.entries(peers)) {
    if (!WATCHED(name)) continue
    if (!satisfies(range)) unmet[name] = range
  }
  return unmet
}

/** Interpretación del veredicto, para que el mensaje diga qué hacer. */
function advice(unmet, manifest) {
  const keys = Object.keys(unmet)
  if (keys.length === 0) return 'compatible'
  if (keys.includes('engines.dsh')) {
    return `engines.dsh es "${unmet['engines.dsh']}" y no satisface el runtime. engines.dsh decide SOLO: amplía el rango o quítalo y usa peers.`
  }
  const pinned = keys.filter((key) => !/[~^><=*|]/.test(String(unmet[key])))
  if (pinned.length === keys.length) {
    return `peer(es) con versión exacta (${keys.map((k) => `${k}@${unmet[k]}`).join(', ')}). Un peer exacto deja de satisfacer en cuanto DSH sube de parche: usa un rango como "^0.2.0" o ">=0.2.0-rc.2 <0.3.0".`
  }
  return `rango(s) fuera de la versión del runtime: ${keys.map((k) => `${k}@${unmet[k]}`).join(', ')}.`
}

/** El comando que el propio host sugiere para aceptar el riesgo, si se prefiere. */
function exemptionCommand(manifest, version) {
  if (typeof manifest?.name !== 'string' || typeof manifest?.version !== 'string') return undefined
  return `dsh plugin allow-version "${manifest.name}@${manifest.version}" "${version}"`
}

/**
 * Examina uno o varios manifiestos.
 * @param manifests - [{ label, path, manifest }]
 * @param version - versión del runtime
 * @param semver - semver del harness
 */
export function inspect(manifests, version, semver) {
  return manifests.map((entry) => {
    // `installed` viaja en el resultado: el llamador no debe re-deducirlo del
    // manifiesto, que aquí no se propaga.
    const installed = entry.manifest !== undefined
    const unmet = installed ? unmetRequirements(entry.manifest, version, semver) : {}
    const ok = !installed ? false : Object.keys(unmet).length === 0
    return {
      label: entry.label,
      path: entry.path,
      name: entry.manifest?.name,
      version: entry.manifest?.version,
      installed,
      ok,
      unmet,
      verdict: installed ? advice(unmet, entry.manifest) : 'no instalado en este perfil',
      watchedPeers: Object.keys(entry.manifest?.peerDependencies ?? {}).filter(WATCHED),
      ignoredPeers: Object.keys(entry.manifest?.peerDependencies ?? {}).filter((name) => !WATCHED(name)),
      exemption: installed && !ok ? exemptionCommand(entry.manifest, version) : undefined,
    }
  })
}

/** Manifiestos instalados en un perfil. */
export function profileManifests(profileDir) {
  let pkg
  try {
    // `createRequire` necesita un ARCHIVO: con un directorio, no resuelve nada.
    const require = createRequire(join(profileDir, 'package.json'))
    pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf-8'))
    const names = Object.keys(pkg.dependencies ?? {})
    const out = []
    for (const name of names) {
      try {
        const path = require.resolve(`${name}/package.json`)
        out.push({ label: name, path, manifest: JSON.parse(readFileSync(path, 'utf-8')) })
      } catch {
        out.push({ label: name, path: undefined, manifest: undefined })
      }
    }
    return out
  } catch {
    return []
  }
}

/*
 * Solo el CLI. `endsWith('env-doctor.mjs')` no sirve: `test-env-doctor.mjs`
 * también termina así y los tests acabarían ejecutando el CLI en vez de las
 * funciones que importan.
 */
const isMain = (() => {
  const entry = process.argv[1]
  if (typeof entry !== 'string') return false
  return entry.replaceAll('\\', '/').split('/').pop() === 'env-doctor.mjs'
})()

if (isMain) {
  const argv = process.argv.slice(2)
  const option = (flag, fallback) => {
    const index = argv.indexOf(`--${flag}`)
    return index === -1 ? fallback : argv[index + 1]
  }
  const home = dshHome(option('home', undefined))
  const profile = option('profile', 'desktop')
  const profileDir = join(home, 'profiles', profile)
  const asJson = argv.includes('--json')

  const runtime = runtimeVersion()
  if (runtime === undefined) {
    console.error('no se pudo determinar la version del runtime (busca app.asar o dsh/package.json)')
    process.exit(2)
  }
  const semver = loadSemver()
  if (semver === undefined) {
    console.error('no se pudo cargar semver desde la instalacion del harness')
    process.exit(2)
  }

  // The npm CLI copy, for the "runtime differs from the CLI" warning. Any
  // harness root works: they all point at the same `dsh` package.
  const cliVersion = (() => {
    for (const base of harnessPackageRoots()) {
      try {
        const parsed = JSON.parse(readFileSync(base, 'utf-8'))
        if (typeof parsed.version === 'string') return parsed.version
      } catch {
        // next candidate
      }
    }
    return undefined
  })()

  const manifests = (() => {
    // `--plugin` permite validar un manifiesto ANTES de instalarlo, que es el
    // momento en que conviene descubrir un peer incompatible.
    const explicit = option('plugin', undefined)
    if (explicit !== undefined) {
      try {
        return [{ label: explicit, path: explicit, manifest: JSON.parse(readFileSync(explicit, 'utf-8')) }]
      } catch (error) {
        console.error(`no se pudo leer ${explicit}: ${String(error.message ?? error)}`)
        process.exit(2)
      }
    }
    return profileManifests(profileDir)
  })()
  const results = inspect(manifests, runtime.version, semver)

  const cliVersionForBanner = cliVersion
  void cliVersionForBanner

  if (asJson) {
    console.log(JSON.stringify({ runtime, cliVersion, profile, results }, null, 2))
  } else {
    console.log(`runtime : ${runtime.version}  (${runtime.kind}: ${runtime.source})`)
    if (cliVersion !== undefined && cliVersion !== runtime.version) {
      console.log(`AVISO   : el CLI npm tiene ${cliVersion}, DISTINTO del runtime real.`)
      console.log('          No uses el CLI para juzgar compatibilidad: el host usa el del asar.')
    }
    console.log(`perfil  : ${profile}  (${manifests.length} dependencias)`)
    console.log('')

    const bad = results.filter((entry) => entry.installed && entry.ok === false)
    const missing = results.filter((entry) => entry.installed === false)
    const good = results.filter((entry) => entry.ok === true)
    console.log('== veredicto ==')
    for (const entry of results) {
      if (entry.installed === false) {
        console.log(`  ?? ${entry.label} — no resuelve (no instalado)`)
        continue
      }
      const tag = entry.ok ? 'ok  ' : 'VETO'
      console.log(`  ${tag} ${entry.label}@${entry.version}`)
      if (!entry.ok) {
        console.log(`        motivo: ${entry.verdict}`)
        for (const [key, range] of Object.entries(entry.unmet)) {
          const satisfies = semver.satisfies(runtime.version, WORKSPACE_RANGES.has(range) ? runtime.version : range, { includePrerelease: true })
          console.log(`        ${key}: "${range}" vs ${runtime.version} -> ${satisfies ? 'cumple' : 'NO cumple'}`)
        }
        if (entry.exemption !== undefined) console.log(`        o aceptar el riesgo: ${entry.exemption}`)
        if (entry.ignoredPeers.length > 0) {
          console.log(`        (no vigilados por el evaluador: ${entry.ignoredPeers.join(', ')})`)
        }
      }
    }
    console.log('')
    console.log(`== ${good.length} compatible(s), ${bad.length} vetado(s), ${missing.length} sin instalar ==`)
    process.exit(bad.length === 0 ? 0 : 1)
  }
}
