/**
 * Compare each engine through a real browser against the same engine over plain
 * HTTP, so the "a browser sees more" claim is measured rather than assumed.
 *
 *   node tools/probe.mjs [--query "..."] [--engine brave] [--channel brave]
 *                        [--show-headful]
 *
 * Reports, per engine: result count, how many carry a snippet, timing, and a few
 * sample titles. Exit code 0 always unless every path failed.
 */
import { ENGINES, normalizeSources, parseHttpResults } from '../src/engines.js'
import { BrowserSearch, resolveBrowser } from '../src/browser.js'

function parseArgs(argv) {
  const args = { query: 'deepseek harness', engines: Object.keys(ENGINES), channel: 'auto', headless: true }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--query') { args.query = value; index += 1 }
    else if (flag === '--engine') { args.engines = [value]; index += 1 }
    else if (flag === '--channel') { args.channel = value; index += 1 }
    else if (flag === '--show-headful') { args.headless = false }
    else if (flag === '--help' || flag === '-h') { args.help = true }
    else throw new Error(`unknown argument: ${flag}`)
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (args.help === true) {
  console.log('usage: node tools/probe.mjs [--query "..."] [--engine name] [--channel brave|edge|chrome|auto]')
  process.exit(0)
}

const resolved = resolveBrowser({ channel: args.channel })
console.log(`navegador: ${resolved.error ?? `${resolved.channel} -> ${resolved.path}`}`)
console.log(`consulta : ${JSON.stringify(args.query)}\n`)

const browser = new BrowserSearch({ channel: args.channel, headless: args.headless })

async function overHttp(engine) {
  const started = Date.now()
  try {
    const response = await fetch(engine.httpUrl(args.query), {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
        'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(20_000),
    })
    const html = await response.text()
    const candidates = parseHttpResults(html, engine)
    const { sources } = normalizeSources(candidates, engine, 10)
    return { ok: true, status: response.status, bytes: html.length, sources, ms: Date.now() - started }
  } catch (error) {
    return { ok: false, error: error.message, sources: [], ms: Date.now() - started }
  }
}

async function overBrowser(engine) {
  const started = Date.now()
  try {
    const { sources, candidates } = await browser.sources(engine.id, args.query, { maxResults: 10 })
    return { ok: true, sources, candidates: candidates.length, ms: Date.now() - started }
  } catch (error) {
    return { ok: false, error: error.message, sources: [], ms: Date.now() - started }
  }
}

const summary = []
for (const engineId of args.engines) {
  const engine = ENGINES[engineId]
  if (engine === undefined) {
    console.log(`?? motor desconocido: ${engineId}`)
    continue
  }
  console.log(`===== ${engine.label} (${engine.id}) =====`)
  const http = await overHttp(engine)
  const nav = await overBrowser(engine)

  const line = (label, result) => {
    const withSnippet = result.sources.filter((source) => typeof source.snippet === 'string' && source.snippet.length > 0).length
    if (result.ok === false) {
      console.log(`  ${label.padEnd(8)} FALLO: ${result.error}`)
      return { label, count: 0, snippets: 0, ms: result.ms, ok: false }
    }
    console.log(
      `  ${label.padEnd(8)} ${String(result.sources.length).padStart(2)} resultados (${withSnippet} con extracto) ${String(result.ms).padStart(6)} ms` +
        (result.status === undefined ? '' : `  HTTP ${result.status}, ${result.bytes} bytes`),
    )
    return { label, count: result.sources.length, snippets: withSnippet, ms: result.ms, ok: true }
  }

  const httpLine = line('HTTP', http)
  const browserLine = line('NAVEGADOR', nav)
  for (const [index, source] of nav.sources.slice(0, 3).entries()) {
    console.log(`      ${index + 1}. ${(source.title ?? '(sin titulo)').slice(0, 70)}`)
    console.log(`         ${source.url.slice(0, 100)}`)
  }
  const better = browserLine.count > httpLine.count ? 'navegador gana' : browserLine.count === httpLine.count ? 'empatan' : 'HTTP gana'
  console.log(`  -> ${better}\n`)
  summary.push({ engine: engine.id, http: httpLine.count, browser: browserLine.count, verdict: better })
}

browser.close()

console.log('=== RESUMEN ===')
for (const row of summary) console.log(`  ${row.engine.padEnd(12)} HTTP ${String(row.http).padStart(2)}  |  navegador ${String(row.browser).padStart(2)}  |  ${row.verdict}`)
const anyOk = summary.some((row) => row.browser > 0 || row.http > 0)
process.exit(anyOk ? 0 : 1)
