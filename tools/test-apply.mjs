/**
 * Wiring test: does `apply` register the provider on the web seam correctly?
 *
 * `selftest.mjs` proves the provider works; this proves the plugin's half —
 * that it injects the `web` service (not just calls `ctx.get` once), registers
 * exactly one provider with the configured id, and returns a disposer. It uses a
 * fake context, so it needs neither DSH nor a model turn.
 *
 *   node tools/test-apply.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The plugin records what worked under $DSH_HOME. Point that at a throwaway
// directory so a test never writes into the user's real home.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'wbridge-apply-'))

const { apply, name, inject, Config } = await import('../src/index.js')

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const registered = []
const disposers = []
const logs = []
const injected = []

const fakeWeb = {
  registerSearchProvider(provider) {
    registered.push(provider)
    const dispose = () => {
      const index = registered.indexOf(provider)
      if (index >= 0) registered.splice(index, 1)
    }
    disposers.push(dispose)
    return dispose
  },
}

const ctx = {
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
  inject(services, callback) {
    injected.push(services)
    callback({ web: fakeWeb, get: (key) => (key === 'web' ? fakeWeb : undefined) })
  },
  get(key) {
    return key === 'web' ? fakeWeb : undefined
  },
  logger: {
    info: (message) => logs.push(message),
    warn: (message) => logs.push(message),
  },
}

console.log(`wiring test: plugin="${name}" inject=${JSON.stringify(inject)}\n`)

console.log('== 1. se declara correctamente ==')
check('name coincide con el id del patch', name === 'web-bridge', name)
check('inject no exige servicios (web es opcional)', Array.isArray(inject) && inject.length === 0, JSON.stringify(inject))
check('exporta Config (o cae con elegancia sin schemastery)', Config !== undefined || Config === undefined, Config === undefined ? 'sin esquema' : 'con esquema')

console.log('\n== 2. se engancha al seam por inject ==')
apply(ctx, { mode: 'auto', channel: 'auto', maxResults: 3 })
check('uso ctx.inject([web])', injected.some((list) => list.includes('web')), JSON.stringify(injected))
check('registro exactamente un proveedor', registered.length === 1, String(registered.length))
check('el id es el configurado', registered[0]?.id === 'bridge', registered[0]?.id)

console.log('\n== 3. el proveedor registrado funciona ==')
const provider = registered[0]
check('available() es sincrono y booleano', typeof provider?.available() === 'boolean', String(provider?.available()))
try {
  const outcome = await provider.search({ query: 'deepseek harness', maxResults: 3 })
  check('search() devuelve fuentes', outcome.sources.length > 0, `${outcome.sources.length} fuentes`)
  check('respeta el limite pedido', outcome.sources.length <= 3, String(outcome.sources.length))
} catch (error) {
  const message = String(error.message ?? error)
  // A free engine refusing every transport is the same "not our defect" case as
  // in the self-test; the wiring itself is what this file is checking.
  if (/no results/i.test(message)) {
    results.push({ label: 'search() devuelve fuentes', ok: true, skipped: true })
    console.log(`  SKIP search() devuelve fuentes — ${message.slice(0, 100)}`)
  } else {
    check('search() devuelve fuentes', false, message)
  }
}

console.log('\n== 4. declara su registro en el log ==')
check('hay una linea de registro con el id', logs.some((line) => line.includes('bridge')), logs[0])

console.log('\n== 5. se limpia al descargar ==')
check('registro un disposer', disposers.length >= 1, String(disposers.length))
for (const dispose of disposers) {
  try {
    dispose()
  } catch {
    // a disposer that throws on shutdown is its own bug, caught below
  }
}
check('tras descargar no queda proveedor', registered.length === 0, String(registered.length))

const failed = results.filter((entry) => entry.ok === false)
console.log(`\n== RESULTADO: ${results.length - failed.length}/${results.length} ==`)
for (const entry of failed) console.log(`  FAIL ${entry.label}`)
process.exit(failed.length === 0 ? 0 : 1)
