/**
 * Engine compatibility matrix.
 *
 * Loads a list of search engines in ONE browser session and reports, per engine,
 * whether it actually rendered results or answered with a challenge / consent
 * wall / empty shell. Built to answer "which engine is most compatible?" with
 * evidence instead of reputation, and to re-run whenever an engine changes.
 *
 *   node tools/engine-matrix.mjs [--query "..."] [--channel brave] [--only google,bing]
 *
 * Verdicts are heuristic on purpose and stated as such:
 *   ok        >= 5 external links and no challenge marker
 *   thin      1..4 external links
 *   challenge a bot/consent marker dominates the page
 *   empty     neither
 */
import { BrowserSearch, resolveBrowser } from '../src/browser.js'
import { resolveUrl } from '../src/engines.js'

const argv = process.argv.slice(2)
const option = (flag, fallback) => {
  const index = argv.indexOf(`--${flag}`)
  return index === -1 ? fallback : argv[index + 1]
}

const query = option('query', 'deepseek harness plugin')
const channel = option('channel', 'auto')
const only = option('only', undefined)
const userDataDir = option('user-data-dir', undefined)
const headless = argv.includes('--headful') === false

const COUNTRIES = 'kl=wt-wt'
const encoded = encodeURIComponent(query)

/**
 * Candidates, including the ones people assume are blocked. `expect` documents
 * what a naive implementation would try; the run reports what actually happens.
 */
const CANDIDATES = [
  { id: 'bing', url: `https://www.bing.com/search?q=${encoded}&setlang=es` },
  { id: 'duckduckgo-html', url: `https://html.duckduckgo.com/html/?q=${encoded}` },
  { id: 'duckduckgo-js', url: `https://duckduckgo.com/?q=${encoded}&${COUNTRIES}` },
  { id: 'google', url: `https://www.google.com/search?q=${encoded}&hl=es` },
  { id: 'google-num', url: `https://www.google.com/search?q=${encoded}&hl=es&num=20&gbv=1` },
  { id: 'google-basic', url: `https://www.google.com/search?q=${encoded}&hl=es&gbv=1&udm=14` },
  { id: 'brave', url: `https://search.brave.com/search?q=${encoded}` },
  { id: 'ecosia', url: `https://www.ecosia.org/search?q=${encoded}` },
  { id: 'startpage', url: `https://www.startpage.com/sp/search?query=${encoded}` },
  { id: 'qwant', url: `https://www.qwant.com/?q=${encoded}&t=web` },
  { id: 'yahoo', url: `https://search.yahoo.com/search?p=${encoded}` },
  { id: 'yandex', url: `https://yandex.com/search/?text=${encoded}` },
  { id: 'mojeek', url: `https://www.mojeek.com/search?q=${encoded}` },
  { id: 'marginalia', url: `https://search.marginalia.nu/search?query=${encoded}` },
  { id: 'wikipedia', url: `https://es.wikipedia.org/w/index.php?search=${encoded}` },
]

const CHALLENGE = /captcha|no eres un bot|unusual traffic|verify you are human|verificando que no eres|antes de continuar|before you continue|consent|aceptar todo|accept all|access denied|forbidden|too many requests/i

const selected = only === undefined ? CANDIDATES : CANDIDATES.filter((entry) => only.split(',').includes(entry.id))

const resolved = resolveBrowser({ channel })
console.log(`navegador: ${resolved.error ?? `${resolved.channel} -> ${resolved.path}`}`)
console.log(`consulta : ${JSON.stringify(query)}`)
console.log(`motores  : ${selected.length}\n`)

const browser = new BrowserSearch({ channel, userDataDir, headless })
const socket = await browser.ensure()

const rows = []
for (const candidate of selected) {
  const started = Date.now()
  let row = { id: candidate.id, verdict: 'error', external: 0, ms: 0, note: '' }
  try {
    await socket.send('Page.navigate', { url: candidate.url })
    // Same wait budget as production, plus a little: a slow render must not be
    // reported as a block.
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) {
      const state = await socket.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true })
      if (state.result?.value === 'complete') break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    await new Promise((resolve) => setTimeout(resolve, 2200))

    const probe = await socket.send('Runtime.evaluate', {
      expression: `(() => {
        const links = Array.from(document.querySelectorAll('a[href]'))
          .map((a) => ({ href: a.href || '', text: (a.textContent || '').replace(/\\s+/g, ' ').trim() }))
          .filter((entry) => /^https?:\\/\\//i.test(entry.href))
          .slice(0, 400);
        const text = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
        return {
          title: document.title,
          url: location.href,
          textLength: text.length,
          head: text.slice(0, 240),
          links,
        };
      })()`,
      returnByValue: true,
    })
    const value = probe.result?.value ?? {}
    row.ms = Date.now() - started

    /*
     * Count DECODED destinations, not raw hosts. Bing wraps every result in
     * `bing.com/ck/a?...`, DuckDuckGo in `//duckduckgo.com/l/?uddg=...`, so a
     * plain "is this link external?" test scores both of them zero while they
     * are in fact returning results. `resolveUrl` unwraps both.
     */
    const engineHost = new URL(candidate.url).hostname.replace(/^www\./, '')
    const seen = new Set()
    for (const link of value.links ?? []) {
      let decoded
      try {
        decoded = resolveUrl(link.href)
      } catch {
        continue
      }
      if (!/^https?:\/\//i.test(decoded)) continue
      let host
      try {
        host = new URL(decoded).hostname.replace(/^www\./, '')
      } catch {
        continue
      }
      if (host === engineHost || host.endsWith(`.${engineHost}`)) continue
      if (link.text.length < 8) continue
      seen.add(decoded.split('#')[0])
    }
    row.external = seen.size
    const looksChallenged = CHALLENGE.test(`${value.title} ${value.head}`)
    if (looksChallenged && row.external < 5) row.verdict = 'challenge'
    else if (row.external >= 5) row.verdict = 'ok'
    else if (row.external >= 1) row.verdict = 'thin'
    else row.verdict = 'empty'
    row.note = `${(value.title ?? '').slice(0, 30)} | texto ${value.textLength}`
    if (row.verdict !== 'ok') row.note += ` | "${(value.head ?? '').slice(0, 70)}"`
  } catch (error) {
    row.note = String(error.message).slice(0, 50)
  }
  rows.push(row)
  console.log(`  ${row.verdict.padEnd(9)} ${row.id.padEnd(16)} enlaces externos ${String(row.external).padStart(3)}  ${String(row.ms).padStart(5)} ms  ${row.note}`)
}

socket.close()
browser.close()

console.log('\n=== COMPATIBILIDAD (mayor a menor) ===')
const ranked = [...rows].sort((left, right) => {
  const score = { ok: 3, thin: 2, empty: 1, challenge: 0, error: 0 }
  return (score[right.verdict] ?? 0) - (score[left.verdict] ?? 0) || right.external - left.external
})
for (const row of ranked) console.log(`  ${row.verdict.padEnd(9)} ${row.id.padEnd(16)} ${String(row.external).padStart(3)} enlaces`)
process.exit(0)
