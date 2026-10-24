/**
 * Tests del memo: clasificación de fallos y esperas proporcionales.
 *
 * El fallo que motivó estos tests, medido en una sesión real: una ráfaga de 122
 * fetches provocó un captcha de DuckDuckGo, el memo lo registró como "no results"
 * y lo dejó diez minutos fuera. Al comprobarlo un minuto después, DuckDuckGo
 * respondía con cinco fuentes. La penalización era correcta en la forma y absurda
 * en la duración.
 *
 *   node tools/test-memo.mjs
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { COOLDOWNS, SearchMemo, classifyFailure } from '../src/memo.js'

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const dir = mkdtempSync(join(tmpdir(), 'wbridge-memo-'))
let counter = 0
const fresh = (cooldownMs) => new SearchMemo(join(dir, `m${counter++}.json`), cooldownMs)

console.log('== 1. clasificación por mensaje ==')
const cases = [
  ['empty', 'empty'],
  [{ message: 'DuckDuckGo: captcha challenge' }, 'captcha'],
  [{ message: 'Bing: an anomaly was detected' }, 'captcha'],
  [{ code: 'WEB_RATE_LIMITED' }, 'rate'],
  [{ message: 'HTTP 429' }, 'rate'],
  [{ message: 'The operation was aborted due to timeout' }, 'network'],
  [{ message: 'fetch failed' }, 'network'],
  [new Error('something else'), 'empty'],
]
for (const [input, want] of cases) {
  check(`${String(typeof input === 'string' ? input : (input.message ?? input.code)).slice(0, 40)}`, classifyFailure(input) === want, classifyFailure(input))
}

console.log('\n== 2. las esperas son las prometidas ==')
check('captcha 60s', COOLDOWNS.captcha === 60_000, String(COOLDOWNS.captcha))
check('network 90s', COOLDOWNS.network === 90_000, String(COOLDOWNS.network))
check('rate 300s', COOLDOWNS.rate === 300_000, String(COOLDOWNS.rate))
check('empty 600s', COOLDOWNS.empty === 600_000, String(COOLDOWNS.empty))
check('captcha < empty', COOLDOWNS.captcha < COOLDOWNS.empty)

console.log('\n== 3. un captcha NO bencha como un resultado vacío ==')
const memo = fresh()
memo.recordFailure('duckduckgo', 'http', 'captcha')
const captchaEntry = memo.data['duckduckgo/http']
check('kind registrado como captcha', captchaEntry.kind === 'captcha', captchaEntry.kind)
check('en cuarentena ahora', memo.cooling('duckduckgo', 'http'))

const other = fresh()
other.recordFailure('bing', 'http', 'empty')
check('empty también en cuarentena', other.cooling('bing', 'http'))
check('captcha expira antes que empty', memo.cooldownFor(captchaEntry) < other.cooldownFor(other.data['bing/http']))

console.log('\n== 4. el éxito limpia la cuarentena ==')
memo.recordSuccess('duckduckgo', 'http')
check('ya no está en cuarentena', !memo.cooling('duckduckgo', 'http'))
check('cuenta como sano', memo.healthy('duckduckgo', 'http'))
check('kind borrado al recuperarse', memo.data['duckduckgo/http'].kind === undefined)
check('aparece en working()', memo.working().some((pair) => pair.engine === 'duckduckgo'))

console.log('\n== 5. compatibilidad con un memo.json antiguo ==')
// Formato previo: { failAt, okAt, reason } sin `kind`.
const legacyPath = join(dir, 'legacy.json')
writeFileSync(legacyPath, JSON.stringify({
  'bing/http': { failAt: Date.now() - 1000, okAt: 0, reason: 'no results' },
  'marginalia/http': { okAt: Date.now(), failAt: 0 },
}), 'utf-8')
const legacy = new SearchMemo(legacyPath)
check('lee el archivo viejo sin lanzar', legacy.data['bing/http'] !== undefined)
check('la entrada vieja sigue en cuarentena', legacy.cooling('bing', 'http'))
check('usa la espera por defecto (10 min)', legacy.cooldownFor(legacy.data['bing/http']) === COOLDOWNS.empty)
check('la entrada sana se conserva', legacy.healthy('marginalia', 'http'))

console.log('\n== 6. cooldown explícito manda sobre el tipo ==')
const forced = fresh(5000)
forced.recordFailure('exa', 'api', 'rate')
check('usa el valor forzado', forced.cooldownFor(forced.data['exa/api']) === 5000)

console.log('\n== 7. no se rompe con archivo corrupto ==')
const badPath = join(dir, 'bad.json')
writeFileSync(badPath, '{ esto no es json', 'utf-8')
const bad = new SearchMemo(badPath)
check('empieza vacío', Object.keys(bad.data).length === 0)
bad.recordFailure('bing', 'http', 'empty')
check('y aun así escribe', readFileSync(badPath, 'utf-8').includes('bing/http'))

rmSync(dir, { recursive: true, force: true })

const failed = results.filter((entry) => entry.ok === false)
console.log(`\n== RESULTADO: ${results.length - failed.length}/${results.length} ==`)
for (const entry of failed) console.log(`  FAIL ${entry.label}`)
process.exit(failed.length === 0 ? 0 : 1)
