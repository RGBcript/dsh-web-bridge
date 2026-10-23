/**
 * Tests del motor semántico y del orden de intentos.
 *
 * El punto crítico que estos tests protegen: un `429` del endpoint público no es
 * "la web está vacía". El cuerpo de un rechazo no es JSON, así que un parser
 * ingenuo lo leería como cero resultados y el modelo creería que no existe nada.
 *
 *   node tools/test-exa.mjs          # sin red: estructura y orden
 *   node tools/test-exa.mjs --live   # además, una llamada real al endpoint
 */
import { ENGINES, ENGINE_PREFERENCE, LEXICAL_ENGINES, API_ENGINES } from '../src/engines.js'
import { isRateLimited, searchExa } from '../src/exa.js'
import { buildAttempts } from '../src/index.js'

const live = process.argv.includes('--live')
const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const memo = { working: () => [], cooling: () => false }

console.log('== 1. registro del motor ==')
check('exa existe en ENGINES', ENGINES.exa !== undefined)
check('exa marcado como semántico', ENGINES.exa?.semantic === true)
check('exa está en API_ENGINES', API_ENGINES.has('exa'))
check('exa NO es léxico', !LEXICAL_ENGINES.has('exa'))
check('exa sin browserUrl (no hay página)', ENGINES.exa?.browserUrl === undefined)

console.log('\n== 2. orden: todo lo léxico antes que lo semántico ==')
for (const mode of ['light', 'auto', 'browser']) {
  const attempts = buildAttempts({ engine: 'auto', mode, fallbackEngines: [] }, memo)
  const firstApi = attempts.findIndex((entry) => entry.transport === 'api')
  const lastLexical = attempts.reduce((acc, entry, index) => (entry.transport !== 'api' ? index : acc), -1)
  const present = firstApi !== -1
  check(`mode=${mode}: exa presente`, present)
  check(`mode=${mode}: exa va después de todo lo léxico`, present && firstApi > lastLexical, `api@${firstApi}, lexico@${lastLexical}`)
}

console.log('\n== 3. exa es el último de la preferencia ==')
check('último en ENGINE_PREFERENCE', ENGINE_PREFERENCE[ENGINE_PREFERENCE.length - 1] === 'exa')

console.log('\n== 4. cooldown lo saca de la lista ==')
const cooling = buildAttempts(
  { engine: 'auto', mode: 'light', fallbackEngines: [] },
  { working: () => [], cooling: (engine) => engine === 'exa' },
)
check('sin exa cuando está en cooldown', cooling.every((entry) => entry.engineId !== 'exa'))

console.log('\n== 5. selección explícita ==')
const explicit = buildAttempts({ engine: 'exa', mode: 'light', fallbackEngines: [] }, memo)
check('engine=exa produce un solo intento', explicit.length === 1 && explicit[0].transport === 'api', JSON.stringify(explicit))

console.log('\n== 6. el 429 es un código propio, no un resultado vacío ==')
const rateError = Object.assign(new Error('rate'), { code: 'WEB_RATE_LIMITED' })
check('isRateLimited reconoce el código', isRateLimited(rateError))
check('isRateLimited rechaza errores normales', !isRateLimited(new Error('boom')))

if (live) {
  console.log('\n== 7. llamada real: consulta semántica sin el nombre exacto ==')
  const started = Date.now()
  try {
    // Deliberadamente sin "Argon": si el motor es léxico, devuelve cero.
    const { candidates } = await searchExa('el modelo nuevo de Google de septiembre de 2026', { maxResults: 3 })
    const elapsed = Date.now() - started
    check('devuelve candidatos', candidates.length > 0, `${candidates.length} en ${elapsed}ms`)
    const found = candidates.some((entry) => /argon/i.test(`${entry.title} ${entry.url}`))
    check('encuentra Argon sin nombrarlo', found, candidates.map((entry) => entry.title.slice(0, 34)).join(' | '))
    check('todos con url absoluta', candidates.every((entry) => /^https?:\/\//.test(entry.url)))
    check('con snippet (highlight)', candidates.some((entry) => typeof entry.snippet === 'string' && entry.snippet.length > 20))
    check('latencia bajo 20s', elapsed < 20000, `${elapsed}ms`)
  } catch (error) {
    if (isRateLimited(error)) {
      console.log('  SKIP rate limitado (esperado bajo carga); reintentar más tarde')
    } else {
      check('llamada real sin error', false, String(error.message).slice(0, 80))
    }
  }
} else {
  console.log('\n(sin --live: no se llamó al endpoint)')
}

const failed = results.filter((entry) => entry.ok === false)
console.log(`\n== RESULTADO: ${results.length - failed.length}/${results.length} ==`)
for (const entry of failed) console.log(`  FAIL ${entry.label}`)
process.exit(failed.length === 0 ? 0 : 1)
