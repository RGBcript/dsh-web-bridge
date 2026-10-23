/**
 * Exa search through its public MCP endpoint.
 *
 * This is the only semantic engine in the bridge. Everything else does lexical
 * matching: ask for "Gemini Argon" and DuckDuckGo returns nothing because the
 * documents say "Gemini 4 Argon" — the tokens simply do not overlap. Exa ranks by
 * meaning, so the same question without the exact name still finds the page.
 *
 * Measured on this machine against `mcp.exa.ai`:
 *
 *  - no credentials of any kind are sent;
 *  - a warm call takes 1.5–4.2 s, roughly ten times a lexical engine;
 *  - 5 concurrent calls produced two `429`s, and the rejected ones answer in
 *    ~330 ms with a non-JSON body — a naive parser reads that as "no results",
 *    which is the bug this module exists to avoid;
 *  - spacing calls 3 s apart produced no `429`, and the limit recovers within
 *    seconds, so the brake is per-call rather than a long ban.
 *
 * Consequences, all deliberate:
 *
 *  - It is **not** a default engine. It runs only when the lexical attempts found
 *    nothing, so a normal search never pays its latency.
 *  - Calls are **serialised** by a module-level mutex: the endpoint rejects
 *    concurrency, so parallelising here would manufacture failures.
 *  - A `429` is reported as `WEB_RATE_LIMITED`, never as an empty result.
 */

/** Public endpoint. The `tools` parameter is mandatory: without it the server
 * does not serve `web_search_advanced_exa` at all and answers "tool not found". */
const MCP_URL = 'https://mcp.exa.ai/mcp?tools=web_search_advanced_exa'

/** Tool that returns structured JSON (the older `web_search_exa` returns prose). */
const MCP_TOOL = 'web_search_advanced_exa'

/** Rejected calls have no meaningful body; keep it short so a probe is cheap. */
const REQUEST_TIMEOUT_MS = 20_000

/**
 * One call at a time.
 *
 * Not for politeness: the endpoint returns `429` when calls overlap, measured at
 * two out of five in a burst. Serialising costs latency we already accept and
 * removes a class of failure that would otherwise look like "the web is empty".
 */
let tail = Promise.resolve()

/** Run `task` after every previously queued task has finished. */
function exclusive(task) {
  const run = tail.then(task, task)
  // Swallow rejections on the chain itself so one failure cannot poison the queue.
  tail = run.then(() => undefined, () => undefined)
  return run
}

/** Error carrying the code the seam understands. */
class ExaRateLimited extends Error {
  constructor(message) {
    super(message)
    this.name = 'ExaRateLimited'
    this.code = 'WEB_RATE_LIMITED'
  }
}

/**
 * Pull the JSON-RPC payload out of a `text/event-stream` body.
 *
 * Parsed line by line, not with a single greedy regex: a real response is tens of
 * kilobytes and a `[\s\S]*` capture spanning from the first `data:` to the last
 * `}` swallows every event and any trailing newline, which then fails
 * `JSON.parse` with "result body was not JSON" — observed before this rewrite.
 */
function parseSse(raw) {
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload.length === 0 || payload === '[DONE]') continue
    try {
      return JSON.parse(payload)
    } catch {
      // keep looking: a stream may carry more than one data line
    }
  }
  return undefined
}

/**
 * Turn one MCP result entry into the shape the bridge reuses.
 * `highlights` holds the sentence Exa selected; the full page text is ignored on
 * purpose — it is the bulk of the response and would flood the caller's context.
 */
function toCandidate(entry) {
  const url = typeof entry?.url === 'string' ? entry.url : undefined
  if (url === undefined) return undefined
  const title = typeof entry.title === 'string' ? entry.title : ''
  const highlight = Array.isArray(entry.highlights) ? entry.highlights[0] : undefined
  const snippet = typeof highlight === 'string' ? highlight : (typeof entry.summary === 'string' ? entry.summary : '')
  return { url, title, snippet: String(snippet).replace(/\s+/g, ' ').trim() }
}

/**
 * Search through Exa.
 *
 * @param query - the user's question, in any wording.
 * @param options - `{ maxResults, signal }`.
 * @returns `{ candidates, engine }`, or throws `ExaRateLimited` on 429.
 */
export async function searchExa(query, { maxResults = 8, signal } = {}) {
  if (signal?.aborted === true) throw new Error('web-bridge: aborted')

  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: MCP_TOOL,
      arguments: {
        query,
        numResults: Math.max(1, Math.min(Number(maxResults) || 8, 10)),
        // `neural` is NOT a valid value here — the server accepts only
        // auto | lite | fast | instant. Measured: `neural` returns -32602.
        type: 'auto',
        enableHighlights: true,
      },
    },
  }

  const response = await exclusive(async () => {
    if (signal?.aborted === true) throw new Error('web-bridge: aborted')
    const call = fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        // Identifying the caller is free and gives the operator someone to blame
        // or contact, instead of an anonymous flood.
        'x-exa-source': 'dsh-web-bridge',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (signal === undefined || signal === null) return call
    // Honour the caller's abort even while the request is in flight.
    const abort = () => {
      void call.catch(() => undefined)
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      return await call
    } finally {
      signal.removeEventListener?.('abort', abort)
    }
  })

  if (response.status === 429) {
    throw new ExaRateLimited('Exa: rate limited (public MCP endpoint)')
  }
  if (!response.ok) {
    throw new Error(`Exa: HTTP ${response.status}`)
  }

  const raw = await response.text()
  const payload = parseSse(raw)
  if (payload === undefined) {
    throw new Error('Exa: unparseable response')
  }

  const text = payload.result?.content?.[0]?.text
  if (payload.result?.isError === true) {
    throw new Error(`Exa: ${String(text ?? 'tool error').slice(0, 120)}`)
  }
  if (typeof text !== 'string' || text.length === 0) {
    return { candidates: [], engine: { id: 'exa', label: 'Exa', hosts: [] } }
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Exa: result body was not JSON')
  }

  const list = Array.isArray(parsed?.results) ? parsed.results : []
  const candidates = list.map(toCandidate).filter((entry) => entry !== undefined)
  return { candidates, engine: { id: 'exa', label: 'Exa', hosts: [] } }
}

/** Whether an error from {@link searchExa} means "slow down", not "no results". */
export function isRateLimited(error) {
  return error?.code === 'WEB_RATE_LIMITED'
}
