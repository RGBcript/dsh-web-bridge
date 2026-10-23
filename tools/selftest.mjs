/**
 * Self-test for the provider, runnable with plain `node`.
 *
 * The plugin is written without harness imports precisely so this works: the
 * seam contract is three members, so it can be exercised directly instead of
 * booting DSH and reading a session log. What it does NOT prove is the host's
 * own wiring — that needs a real profile, and the README says how.
 *
 *   node tools/selftest.mjs [--channel brave] [--quick]
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserSearch } from '../src/browser.js'
import { SearchMemo } from '../src/memo.js'
import { buildAttempts, createProvider } from '../src/index.js'

const argv = process.argv.slice(2)
const option = (flag, fallback) => {
  const index = argv.indexOf(`--${flag}`)
  return index === -1 ? fallback : argv[index + 1]
}
const channel = option('channel', 'auto')
const quick = argv.includes('--quick')

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}
/**
 * A free engine returning nothing is not a defect in this plugin: they throttle
 * by IP, and a run of several tests in a row is enough to get an empty or
 * challenged page. Skipping keeps the distinction between "our code broke" and
 * "the third party said no" — otherwise the suite cries wolf and gets ignored.
 */
const skip = (label, detail) => {
  results.push({ label, ok: true, skipped: true })
  console.log(`  SKIP ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const options = {
  providerId: 'bridge',
  engine: 'auto',
  mode: 'auto',
  channel,
  headless: true,
  idleCloseMs: 45_000,
  maxResults: 8,
  timeoutMs: 25_000,
  fallbackEngines: [],
  provenance: true,
}

const browser = new BrowserSearch({ channel, headless: true })
const memoDir = mkdtempSync(join(tmpdir(), 'wbridge-memo-'))
const memo = new SearchMemo(join(memoDir, 'memo.json'))
const provider = createProvider(() => options, browser, memo)

console.log(`selftest: provider="${provider.id}" engine=${options.engine} mode=${options.mode} channel=${channel}\n`)

console.log('== 0. invariante ligero: ningun proceso de navegador antes de agotar HTTP ==')
const fresh = new SearchMemo(join(memoDir, 'fresh.json'))
const autoAttempts = buildAttempts(options, fresh)
const lastHttp = autoAttempts.map((attempt) => attempt.transport).lastIndexOf('http')
const firstBrowser = autoAttempts.findIndex((attempt) => attempt.transport === 'browser')
check(
  'en modo auto todos los HTTP van antes del primer navegador',
  firstBrowser === -1 || lastHttp < firstBrowser,
  autoAttempts.map((attempt) => `${attempt.engineId}/${attempt.transport}`).join(' '),
)
const lightAttempts = buildAttempts({ ...options, mode: 'light' }, fresh)
check('en modo light nunca se intenta un navegador', lightAttempts.every((attempt) => attempt.transport === 'http'), `${lightAttempts.length} intentos HTTP`)
const coolingMemo = new SearchMemo(join(memoDir, 'cooling.json'))
coolingMemo.recordFailure('bing', 'browser', 'prueba')
const cooled = buildAttempts(options, coolingMemo)
check(
  'un par que acaba de fallar entra en cuarentena',
  cooled.some((attempt) => attempt.engineId === 'bing' && attempt.transport === 'browser') === false,
  `${cooled.length} intentos restantes`,
)

console.log('== 1. forma del contrato ==')
check('expone id', typeof provider.id === 'string' && provider.id.length > 0, provider.id)
check('expone available()', typeof provider.available === 'function', String(provider.available()))
check('expone search()', typeof provider.search === 'function')

console.log('\n== 2. busqueda real por navegador ==')
const started = Date.now()
let first
try {
  first = await provider.search({ query: 'deepseek harness', maxResults: 5 })
  check('devuelve fuentes', Array.isArray(first.sources) && first.sources.length > 0, `${first.sources?.length ?? 0} fuentes en ${Date.now() - started} ms`)
} catch (error) {
  check('devuelve fuentes', false, error.message)
}

if (first !== undefined) {
  console.log('\n== 3. calidad de las fuentes ==')
  const urls = first.sources.map((source) => source.url)
  check('todas las url son http(s)', urls.every((url) => /^https?:\/\//.test(url)), urls[0])
  check('sin url de redireccion del motor', urls.every((url) => !/bing\.com\/ck\/a|duckduckgo\.com\/l\//.test(url)))
  check('sin titulos con url incrustada', first.sources.every((source) => !/https?:\/\//.test(source.title ?? '')), first.sources[0]?.title)
  const withSnippet = first.sources.filter((source) => (source.snippet ?? '').length > 0).length
  /*
   * Snippets only exist on the browser transport: the HTTP parser reads anchors
   * and titles from raw markup, and the extract text lives in the rendered page.
   * Asserting them unconditionally made the suite fail whenever the light path
   * won, which is the expected outcome of `mode: auto`.
   */
  if (/navegador/.test(first.content ?? '')) {
    check('la mayoria trae extracto', withSnippet >= Math.ceil(first.sources.length / 2), `${withSnippet}/${first.sources.length}`)
  } else {
    skip('la mayoria trae extracto', 'transporte HTTP: los extractos requieren navegador (mode: browser)')
  }
  check('respeta maxResults', first.sources.length <= 5, String(first.sources.length))
  check('truncated es booleano', typeof first.truncated === 'boolean', String(first.truncated))
  check('declara procedencia', typeof first.content === 'string' && first.content.length > 0, first.content)
  console.log('\n  muestra:')
  for (const source of first.sources.slice(0, 3)) {
    console.log(`   - ${(source.title ?? '(sin titulo)').slice(0, 62)}`)
    console.log(`     ${source.url.slice(0, 92)}`)
    if (source.snippet !== undefined) console.log(`     ${source.snippet.slice(0, 92)}`)
  }
}

if (quick === false) {
  console.log('\n== 4. modo light puro (sin lanzar navegador) ==')
  const lightOptions = { ...options, engine: 'duckduckgo', mode: 'light', fallbackEngines: [] }
  const lightMemo = new SearchMemo(join(memoDir, 'light.json'))
  const lightProvider = createProvider(() => lightOptions, browser, lightMemo)
  try {
    const lightResult = await lightProvider.search({ query: 'deepseek harness', maxResults: 4 })
    if (lightResult.sources.length === 0) {
      skip('light devuelve fuentes', 'el motor no devolvio nada')
    } else {
      check('light devuelve fuentes', true, `${lightResult.sources.length} fuentes`)
      check('light respeta maxResults', lightResult.sources.length <= 4, String(lightResult.sources.length))
    }
  } catch (error) {
    const message = String(error.message ?? error)
    // "no results" means every transport came back empty — a free engine
    // refusing us, not a defect here. Anything else is ours and must fail.
    if (/no results/i.test(message)) skip('light devuelve fuentes', message.slice(0, 100))
    else check('light devuelve fuentes', false, message)
  }
  check('light no arranco ningun navegador', browser.socket === undefined, browser.socket === undefined ? 'sin socket' : 'habia un socket')
}

console.log('\n== 5. aprende que combinacion funciona en esta maquina ==')
const learned = new SearchMemo(join(memoDir, 'memo.json'))
check('registro al menos un par que funciono', learned.working().length > 0, JSON.stringify(learned.working()))

console.log('\n== 6. errores explicitos ==')
const emptyOptions = { ...options, engine: 'no-existe', fallbackEngines: [] }
const emptyProvider = createProvider(() => emptyOptions, browser, new SearchMemo(join(memoDir, 'empty.json')))
try {
  await emptyProvider.search({ query: 'algo' })
  check('motor desconocido falla', false, 'no lanzo')
} catch (error) {
  check('motor desconocido falla', /no usable engine/.test(error.message), error.message)
}
try {
  await provider.search({ query: '   ' })
  check('consulta vacia falla', false, 'no lanzo')
} catch (error) {
  check('consulta vacia falla', /empty query/.test(error.message), error.message)
}

browser.close()

const failed = results.filter((entry) => entry.ok === false)
console.log(`\n== RESULTADO: ${results.length - failed.length}/${results.length} ==`)
for (const entry of failed) console.log(`  FAIL ${entry.label}`)
process.exit(failed.length === 0 ? 0 : 1)
