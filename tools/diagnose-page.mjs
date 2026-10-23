/**
 * Page diagnostics: what did the browser actually load?
 *
 * When a search returns zero results the cause is one of three, and guessing
 * between them wastes far more time than measuring: the page is a consent wall
 * or challenge, the engine renders results under different markup than assumed,
 * or the results simply were not there yet. This prints the title, the text, and
 * the hit count for every selector the extraction relies on.
 *
 *   node tools/diagnose-page.mjs [--engine brave] [--query "..."] [--wait 4000]
 */
import { ENGINES } from '../src/engines.js'
import { BrowserSearch, resolveBrowser } from '../src/browser.js'

const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1]
}

const engineId = option('engine', 'duckduckgo')
const query = option('query', 'deepseek harness plugin')
const extraWait = Number(option('wait', '4000'))
const channel = option('channel', 'auto')
const forcedUrl = option('url', undefined)
const dumpSelector = option('dump', undefined)

const engine = forcedUrl === undefined ? ENGINES[engineId] : { ...(ENGINES[engineId] ?? { id: engineId, label: engineId }), browserUrl: () => forcedUrl }
if (engine === undefined) {
  console.error(`unknown engine: ${engineId}`)
  process.exit(2)
}

const resolved = resolveBrowser({ channel })
console.log(`navegador: ${resolved.error ?? `${resolved.channel} -> ${resolved.path}`}`)
console.log(`motor    : ${engine.label}`)
console.log(`url      : ${engine.browserUrl(query)}\n`)

const browser = new BrowserSearch({ channel })
const socket = await browser.ensure()
await socket.send('Page.navigate', { url: engine.browserUrl(query) })

// Give the page far more time than the production settle window, so a slow
// render is distinguishable from a missing one.
await new Promise((resolve) => setTimeout(resolve, extraWait))

const report = await socket.send('Runtime.evaluate', {
  expression: `(() => {
    const text = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
    const selectors = {
      'a[href^="http"]': document.querySelectorAll('a[href^="http"]').length,
      'article[data-testid=result]': document.querySelectorAll('article[data-testid="result"]').length,
      '.result': document.querySelectorAll('.result').length,
      '.result__a': document.querySelectorAll('.result__a').length,
      'li.b_algo': document.querySelectorAll('li.b_algo').length,
      'h2 a': document.querySelectorAll('h2 a').length,
      '.snippet': document.querySelectorAll('.snippet').length,
      '#results': document.querySelectorAll('#results').length,
      'form[action*=search]': document.querySelectorAll('form[action*="search"]').length,
    };
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).slice(0, 12).map((b) => (b.innerText || '').trim().slice(0, 40)).filter(Boolean);
    return {
      url: location.href,
      title: document.title,
      textLength: text.length,
      textHead: text.slice(0, 320),
      selectors,
      buttons,
    };
  })()`,
  returnByValue: true,
})

const value = report.result?.value ?? {}
console.log('url final   :', value.url)
console.log('titulo      :', value.title)
console.log('texto       :', value.textLength, 'caracteres')
console.log('inicio      :', JSON.stringify(value.textHead))
console.log('botones     :', JSON.stringify(value.buttons))
console.log('selectores  :')
for (const [selector, count] of Object.entries(value.selectors ?? {})) {
  console.log(`  ${String(count).padStart(4)}  ${selector}`)
}

// Run the production extractor too: a selector count can be non-zero while the
// extractor still returns nothing, and that difference matters.
if (typeof engine.extract === 'function') {
  const extracted = await socket.send('Runtime.evaluate', {
    expression: `(${engine.extract.toString()})()`,
    returnByValue: true,
  })
  const list = extracted.result?.value
  console.log('\nextractor   :', Array.isArray(list) ? `${list.length} candidatos` : `no devolvio array (${JSON.stringify(list)})`)
  if (Array.isArray(list)) {
    for (const [index, item] of list.slice(0, 3).entries()) {
      console.log(`  ${index + 1}. title=${JSON.stringify(item.title)}`)
      console.log(`     snippet=${JSON.stringify((item.snippet ?? '').slice(0, 80))}`)
      console.log(`     url=${String(item.url).slice(0, 80)}`)
    }
  }
}

// Dump real markup so a selector can be corrected against the page instead of
// guessed a second time.
if (dumpSelector !== undefined) {
  const dump = await socket.send('Runtime.evaluate', {
    expression: `(() => {
      const node = document.querySelector(${JSON.stringify(dumpSelector)});
      if (!node) return 'NO MATCH: ' + ${JSON.stringify(dumpSelector)};
      return node.outerHTML.replace(/\\s+/g, ' ').slice(0, 1200);
    })()`,
    returnByValue: true,
  })
  console.log(`\nHTML de ${dumpSelector}:`)
  console.log('  ' + String(dump.result?.value ?? '').slice(0, 1200))
}

socket.close()
browser.close()
process.exit(0)
