/**
 * Engine definitions for the search bridge.
 *
 * Two extraction paths per engine, because they are not equivalent:
 *
 *  - `extract` runs inside a real browser page, after the engine's own
 *    JavaScript has rendered the results. This is the path that matters: it can
 *    read what a person sees.
 *  - `http` only fetches markup. It is the fallback for machines without a
 *    browser, and it systematically sees less — no client-rendered results, no
 *    lazy-loaded snippets, and whatever the server decides to send a bot.
 *
 * Each `extract` function is serialised with `Function.prototype.toString` and
 * evaluated in the page, so it must be self-contained: no closures, no imports.
 */

/**
 * Titles/snippets arrive with newlines and entities baked in; flatten them.
 *
 * Entities are decoded rather than left raw: a live Bing page returned
 * "DeepSeek en espa&#241;ol", which is not a title a person would write and looks
 * like corruption in a citation. Only the common named entities plus numeric
 * forms are handled — a full table would cost more than it is worth here.
 */
function plain(value) {
  return String(value ?? '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * DuckDuckGo's rendered results page.
 * The visible product is the `article[data-testid="result"]` list; the classic
 * `.result` markup is kept as a secondary match because DDG still serves it in
 * some regions and A/B buckets.
 */
function extractDuckDuckGo() {
  const out = []
  const push = (url, title, snippet) => {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return
    out.push({ url, title: String(title || ''), snippet: String(snippet || '') })
  }
  for (const article of document.querySelectorAll('article[data-testid="result"]')) {
    const link = article.querySelector('a[data-testid="result-title-a"]') || article.querySelector('h2 a') || article.querySelector('a[href^="http"]')
    if (!link) continue
    const snippet = article.querySelector('[data-result="snippet"]') || article.querySelector('[data-testid="result-snippet"]') || article.querySelector('.result__snippet')
    push(link.href, link.textContent, snippet ? snippet.textContent : '')
  }
  if (out.length === 0) {
    for (const item of document.querySelectorAll('.result, .web-result')) {
      const link = item.querySelector('.result__a') || item.querySelector('a[href^="http"]')
      if (!link) continue
      const snippet = item.querySelector('.result__snippet')
      push(link.href, link.textContent, snippet ? snippet.textContent : '')
    }
  }
  return out
}

/**
 * Bing's `li.b_algo` blocks.
 *
 * The title anchor also contains Bing's display-URL decoration (`deepseek.com`
 * plus the bare `https://…`), so the title is read from a clone with those nodes
 * removed and any leftover URL stripped. Without that, every citation came back
 * titled "deepseek.comhttps://www.deepseek.com".
 */
function extractBing() {
  const out = []
  for (const item of document.querySelectorAll('li.b_algo')) {
    // Explicit fallback chain, NOT a comma selector: `querySelector('h2 a, a')`
    // returns whichever matches first in document order, which on Bing is the
    // display-URL anchor, not the title one.
    const link = item.querySelector('h2 a') || item.querySelector('a[href^="http"]')
    if (!link) continue
    let title = ''
    try {
      const clone = link.cloneNode(true)
      for (const junk of clone.querySelectorAll('cite, .tptt, .b_attribution, .siteLink')) junk.remove()
      title = String(clone.textContent || '')
    } catch {
      title = String(link.textContent || '')
    }
    title = title.replace(/https?:\/\/\S+/g, ' ').replace(/^[\w-]+(\.[\w-]+)+/, ' ')
    const snippet = item.querySelector('.b_caption p') || item.querySelector('.b_lineclamp2, .b_lineclamp3, .b_lineclamp4') || item.querySelector('p')
    out.push({ url: link.href, title, snippet: String(snippet ? snippet.textContent : '') })
  }
  return out.filter((entry) => /^https?:\/\//.test(entry.url))
}

/** Brave Search's own result list. */
function extractBrave() {
  const out = []
  for (const item of document.querySelectorAll('#results .snippet[data-type="web"], #results > div .snippet, .snippet[data-pos]')) {
    const link = item.querySelector('a[href^="http"]')
    if (!link) continue
    const title = item.querySelector('.title, .snippet-title')
    const snippet = item.querySelector('.snippet-description, .snippet-content, .description')
    out.push({
      url: link.href,
      title: String((title || link).textContent || ''),
      snippet: String(snippet ? snippet.textContent : ''),
    })
  }
  return out.filter((entry) => /^https?:\/\//.test(entry.url))
}

/** Marginalia: small independent index, plain result blocks. */
function extractMarginalia() {
  const out = []
  for (const item of document.querySelectorAll('.search-result, .card.search-result, .result')) {
    const link = item.querySelector('a[href^="http"]')
    if (!link) continue
    const snippet = item.querySelector('.description, p')
    out.push({ url: link.href, title: String(link.textContent || ''), snippet: String(snippet ? snippet.textContent : '') })
  }
  return out.filter((entry) => /^https?:\/\//.test(entry.url))
}

/**
 * Both result shapes are normalised here rather than in the page: DDG and Brave
 * sometimes hand back their own redirect wrapper, and resolving it in Node keeps
 * the in-page code small.
 *
 * Three wrappers are handled, each learned from a real failure:
 *  - `//host/...` — protocol-relative, which `new URL` rejects without a base and
 *    which silently dropped every DuckDuckGo HTML result.
 *  - `duckduckgo.com/l/?uddg=<encoded>` — the click redirect on their HTML page.
 *  - `bing.com/ck/a?…&u=a1<base64url>` — Bing's click redirect, where the target
 *    is base64url behind an `a1` marker.
 */
export function decodeBingRedirect(href) {
  try {
    const parsed = new URL(href)
    if (!/(^|\.)bing\.com$/i.test(parsed.hostname)) return href
    if (!parsed.pathname.startsWith('/ck/a')) return href
    const wrapped = parsed.searchParams.get('u')
    if (typeof wrapped !== 'string' || !wrapped.startsWith('a1')) return href
    const body = wrapped.slice(2).replace(/-/g, '+').replace(/_/g, '/')
    const padded = body + '='.repeat((4 - (body.length % 4)) % 4)
    const decoded = Buffer.from(padded, 'base64').toString('utf8')
    return /^https?:\/\//i.test(decoded) ? decoded : href
  } catch {
    return href
  }
}

/**
 * Google wraps every result in a same-origin `/url?q=<target>` hop. Left
 * unwrapped, the destination looks like `google.com/...` and gets filtered out
 * as an internal link, which is why a Google search can render perfectly and
 * still report zero results.
 */
export function decodeGoogleRedirect(href) {
  try {
    const parsed = new URL(href)
    if (!/(^|\.)google\.[a-z.]+$/i.test(parsed.hostname)) return href
    if (!parsed.pathname.startsWith('/url')) return href
    const target = parsed.searchParams.get('q') ?? parsed.searchParams.get('url')
    if (typeof target !== 'string') return href
    const decoded = /^https?%3A/i.test(target) ? decodeURIComponent(target) : target
    return /^https?:\/\//i.test(decoded) ? decoded : href
  } catch {
    return href
  }
}

export function resolveUrl(url) {
  let value = String(url ?? '').trim()
  if (value.startsWith('//')) value = `https:${value}`
  try {
    const parsed = new URL(value)
    const wrapped = parsed.searchParams.get('uddg') ?? parsed.searchParams.get('url')
    if (typeof wrapped === 'string') {
      const decoded = /^https?%3A/i.test(wrapped) ? decodeURIComponent(wrapped) : wrapped
      if (/^https?:\/\//i.test(decoded)) return decoded
    }
    return decodeBingRedirect(decodeGoogleRedirect(value))
  } catch {
    return value
  }
}

/** Strip tracking parameters that make two results look different. */
export function canonicalUrl(url) {
  try {
    const parsed = new URL(resolveUrl(url))
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|msclkid|ref|ref_src|source)/i.test(key)) parsed.searchParams.delete(key)
    }
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return url
  }
}

/** Engines the bridge can drive. `hosts` are filtered out of results. */
export const ENGINES = {
  duckduckgo: {
    id: 'duckduckgo',
    label: 'DuckDuckGo',
    // The JavaScript app at `duckduckgo.com/?q=` renders its result list only
    // after interaction, and under headless it came back with the chrome and
    // zero results. Their server-rendered endpoint paints real results in both
    // modes, so both paths use it.
    browserUrl: (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    httpUrl: (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    extract: extractDuckDuckGo,
    hosts: ['duckduckgo.com'],
    settleMs: 1200,
  },
  bing: {
    id: 'bing',
    label: 'Bing',
    browserUrl: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=es`,
    httpUrl: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=es`,
    extract: extractBing,
    hosts: ['bing.com', 'microsoft.com'],
    settleMs: 1500,
  },
  brave: {
    id: 'brave',
    label: 'Brave Search',
    // Measured headless: Brave Search answers with a "Verificando que no eres un
    // bot" challenge and no results. Kept because it works when the bridge is
    // pointed at a real logged-in profile (`userDataDir`), but it is not a safe
    // default.
    browserUrl: (query) => `https://search.brave.com/search?q=${encodeURIComponent(query)}`,
    httpUrl: (query) => `https://search.brave.com/search?q=${encodeURIComponent(query)}`,
    extract: extractBrave,
    hosts: ['brave.com'],
    settleMs: 1800,
    needsSession: true,
  },
  marginalia: {
    id: 'marginalia',
    label: 'Marginalia',
    browserUrl: (query) => `https://search.marginalia.nu/search?query=${encodeURIComponent(query)}`,
    httpUrl: (query) => `https://search.marginalia.nu/search?query=${encodeURIComponent(query)}`,
    extract: extractMarginalia,
    hosts: ['marginalia.nu'],
    settleMs: 1500,
  },
  /*
   * Semantic engine. No `browserUrl`: there is no page to render, the endpoint
   * answers JSON-RPC. `searchExa` in `exa.js` owns the transport, its mutex and
   * the 429 handling; this entry exists so the rest of the plugin can treat it
   * like any other engine.
   */
  exa: {
    id: 'exa',
    label: 'Exa',
    hosts: [],
    settleMs: 0,
    semantic: true,
  },
}

/**
 * Order tried when the configured engine yields nothing.
 *
 * Measured on this machine: Bing renders under headless Brave, DuckDuckGo's HTML
 * endpoint renders in both modes, Marginalia is small but stable, and Brave
 * Search challenges headless. The healthy default therefore leads with Bing.
 *
 * `exa` sits last on purpose — see {@link LEXICAL_ENGINES} for why it is not a
 * peer of the others.
 */
export const ENGINE_PREFERENCE = ['bing', 'duckduckgo', 'marginalia', 'brave', 'exa']

/**
 * Engines that match words, as opposed to meaning.
 *
 * The distinction drives the order of attempts, not just the preference list:
 * every lexical engine is tried first, cheaply, and only if they all return
 * nothing does the semantic engine run. Measured cost of that rule: a normal
 * search pays ~1 s, and the ~5 s semantic call happens only when the words and
 * the documents do not share tokens — which is exactly the case it exists for.
 */
export const LEXICAL_ENGINES = new Set(['bing', 'duckduckgo', 'marginalia', 'brave'])

/** Engines answered by an API rather than by a rendered page. */
export const API_ENGINES = new Set(['exa'])

/**
 * Which transport actually works for each engine, measured on this machine.
 *
 * This is not a preference in the taste sense — it is the observed outcome:
 * DuckDuckGo answers plain HTTP with results but challenges the browser with a
 * captcha, while Bing renders results in the browser and sends almost nothing
 * useful to a bare HTTP client. `auto` mode tries the listed transport first and
 * the other one only if it came back empty, so an engine changing its policy
 * degrades instead of breaking.
 */
export const PREFERRED_MODE = {
  bing: 'browser',
  brave: 'browser',
  duckduckgo: 'http',
  marginalia: 'http',
}

/** Transport to try first for an engine. */
export function preferredModeOf(engineId) {
  return PREFERRED_MODE[engineId] ?? 'browser'
}

/**
 * Turn raw page candidates into the seam's `WebSearchSource[]`.
 *
 * Returns `{ sources, truncated }`. `truncated` reports whether the `maxResults`
 * cap actually discarded usable results: the seam exposes that flag to the model,
 * and hardcoding it to `false` would claim a complete list when the caller asked
 * for fewer rows than the engine produced.
 */
export function normalizeSources(candidates, engine, maxResults) {
  const seen = new Set()
  const sources = []
  let usable = 0
  for (const candidate of candidates) {
    if (typeof candidate?.url !== 'string') continue
    const url = canonicalUrl(candidate.url)
    if (!/^https?:\/\//.test(url)) continue
    let host = ''
    try {
      host = new URL(url).hostname
    } catch {
      continue
    }
    if (engine.hosts.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) continue
    if (seen.has(url)) continue
    seen.add(url)
    usable += 1
    if (maxResults !== undefined && sources.length >= maxResults) continue
    const title = plain(candidate.title)
      // Some engines (Marginalia among them) concatenate the destination into the
      // title. A citation whose title is a URL is noise, so drop it centrally
      // instead of patching each extractor.
      .replace(/https?:\/\/\S+/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const snippet = plain(candidate.snippet)
    sources.push({
      url,
      ...(title.length > 0 ? { title } : {}),
      ...(snippet.length > 0 ? { snippet } : {}),
    })
  }
  return { sources, truncated: maxResults !== undefined && usable > sources.length }
}

/**
 * Parse an HTTP-only result page.
 *
 * Deliberately regex-based: the plugin ships with no HTML parser dependency, and
 * this path is only a fallback. It reads anchors, then keeps the ones whose text
 * looks like a title — navigation links are short, result titles are not — so a
 * raw page does not fill the citations with menu items.
 */
export function parseHttpResults(html, engine) {
  // Bing needs its own path: every `href` it serves is an opaque
  // `bing.com/ck/a?p=<hex>` redirector, so the generic anchor scan finds 22
  // links, all on a blocked host, and normalisation discards the lot. The real
  // destination is in the `<cite>` element of each result block.
  if (engine?.id === 'bing') return parseBingHttp(html)

  const candidates = []
  const anchor = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let match
  while ((match = anchor.exec(html)) !== null) {
    const url = match[1]
    if (!/^https?:\/\//i.test(url) && !url.startsWith('//')) continue
    const text = plain(match[2].replace(/<[^>]+>/g, ' '))
    if (text.length < 12) continue
    candidates.push({ url, title: text, snippet: '' })
  }
  return candidates
}

/**
 * Bing's HTTP results, split per `li.b_algo` block.
 *
 * Measured on a live page: `<cite>` always carries the human-readable
 * destination (`https://www.deepseek.com`), while every `href` is a redirector.
 * The title comes from the `<h2>` anchor with Bing's display-URL decoration
 * (`deepseek.comhttps://www.deepseek.com`) stripped, and the snippet from
 * `.b_caption p`. Navigation entries such as "Imágenes" live outside `b_algo`,
 * so scoping to that class removes them for free.
 */
function parseBingHttp(html) {
  const candidates = []
  const block = /<li class="b_algo"[\s\S]*?(?=<li class="b_algo"|<\/ol>|$)/gi
  let item
  while ((item = block.exec(html)) !== null) {
    const chunk = item[0]
    const cite = chunk.match(/<cite[^>]*>([\s\S]*?)<\/cite>/i)
    const citation = plain(cite === null ? '' : cite[1].replace(/<[^>]+>/g, ' '))
    // `cite` shows the URL without always keeping the scheme; normalise it.
    const url = citation.length === 0 ? undefined : /^https?:\/\//i.test(citation) ? citation : `https://${citation}`
    if (url === undefined || url === 'https://') continue

    const anchor = chunk.match(/<h2[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i)
    const title = plain(anchor === null ? '' : anchor[1].replace(/<[^>]+>/g, ' '))
      .replace(/https?:\/\/\S+/gi, ' ')
      .replace(/^[\w-]+(\.[\w-]+)+\s*/, '')
      .trim()

    const snippetMatch = chunk.match(/<p class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
      ?? chunk.match(/<div class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i)
    const snippet = plain(snippetMatch === null ? '' : snippetMatch[1].replace(/<[^>]+>/g, ' '))

    candidates.push({ url, title, snippet })
  }
  return candidates
}
