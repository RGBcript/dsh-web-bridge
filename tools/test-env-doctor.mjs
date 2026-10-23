/**
 * Tests del doctor de compatibilidad.
 *
 * Importa porque el gate del gestor de plugins no se ejecuta fuera de Electron:
 * si esta emulación falla, el preflight vuelve a mentir y se pierden reinicios
 * enteros persiguiendo el síntoma equivocado.
 *
 *   node tools/test-env-doctor.mjs
 */
import { readFileSync } from 'node:fs'
import { inspect, loadSemver, runtimeVersion, unmetRequirements } from './env-doctor.mjs'

const semver = loadSemver()
const runtime = runtimeVersion()
const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

if (semver === undefined || runtime === undefined) {
  console.error('no se pudo cargar semver o el runtime')
  process.exit(2)
}
const V = runtime.version
console.log(`runtime ${V}\n`)

const unmet = (manifest) => Object.keys(unmetRequirements(manifest, V, semver)).length > 0

console.log('== 1. peer exacto vetado, rango aceptado ==')
check('peer exacto de la version anterior -> veta', unmet({ peerDependencies: { '@deepseek-ai/dsh-web': '0.2.0-rc.2' } }))
check('rango >= < acepta', !unmet({ peerDependencies: { '@deepseek-ai/dsh-web': '>=0.2.0-rc.2 <0.3.0' } }))
check('caret acepta', !unmet({ peerDependencies: { '@deepseek-ai/dsh-web': '^0.2.0' } }))
check('tilde acepta', !unmet({ peerDependencies: { '@deepseek-ai/dsh-web': '~0.2.0' } }))

console.log('\n== 2. engines.dsh decide SOLO e ignora los peers ==')
check(
  'engines.dsh cumple + peer roto -> compatible',
  !unmet({ engines: { dsh: '>=0.2.0-rc.2 <0.3.0' }, peerDependencies: { '@deepseek-ai/dsh-web': '0.0.1' } }),
)
check(
  'engines.dsh incumple + peer bueno -> veta',
  unmet({ engines: { dsh: '0.1.0' }, peerDependencies: { '@deepseek-ai/dsh-web': '>=0.2.0-rc.2 <0.3.0' } }),
)

console.log('\n== 3. solo se vigilan los peers @deepseek-ai/dsh y dsh-* ==')
check('peer ajeno no veta', !unmet({ peerDependencies: { 'left-pad': '0.0.1' } }))
check('schemastery no veta', !unmet({ peerDependencies: { '@deepseek-ai/schemastery': '~3.18.4' } }))
check('peer dsh-web veta si no cumple', unmet({ peerDependencies: { '@deepseek-ai/dsh-web': '0.0.1' } }))

console.log('\n== 4. workspace:^ equivale a la version del runtime ==')
check('workspace:^ acepta', !unmet({ peerDependencies: { '@deepseek-ai/dsh-web': 'workspace:^' } }))
check('workspace:* acepta', !unmet({ peerDependencies: { '@deepseek-ai/dsh-web': 'workspace:*' } }))
check('rango vacio veta', unmet({ peerDependencies: { '@deepseek-ai/dsh-web': '' } }))

console.log('\n== 5. veredicto y remedio ==')
const pinned = inspect([{ label: 'x', path: 'x', manifest: { name: 'x', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-web': '0.2.0-rc.2' } } }], V, semver)[0]
check('marca incompatible', pinned.ok === false)
check('explica que el peer es exacto', /exacta/.test(pinned.verdict))
check('ofrece el comando de exencion', typeof pinned.exemption === 'string' && pinned.exemption.includes('allow-version'))

const missing = inspect([{ label: 'y', path: undefined, manifest: undefined }], V, semver)[0]
check('manifiesto ausente no rompe', missing.installed === false && missing.ok === false)

console.log('\n== 6. el propio paquete cumple ==')
const self = inspect([{ label: 'self', path: 'self', manifest: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) }], V, semver)[0]
check('dsh-web-bridge es compatible', self.ok === true, self.ok ? undefined : JSON.stringify(self.unmet))

const failed = results.filter((entry) => entry.ok === false)
console.log(`\n== RESULTADO: ${results.length - failed.length}/${results.length} ==`)
for (const entry of failed) console.log(`  FAIL ${entry.label}`)
process.exit(failed.length === 0 ? 0 : 1)
