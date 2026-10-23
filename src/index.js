/**
 * Free web-search provider for the DeepSeek Harness `ctx.web` seam.
 *
 * What this is, precisely: a replacement backend for the harness's own
 * `web_search` tool. The tool keeps its name, its arguments and its rendering —
 * only the thing that performs the search changes, from the DeepSeek-billed
 * endpoint to a free engine rendered by a real browser.
 *
 * Two design points that are easy to get wrong:
 *
 *  1. Registering is not enough. The seam refuses to guess: with two usable
 *     search providers and no pin it fails every call with
 *     `WEB_PROVIDER_AMBIGUOUS`. The `web` entry must set `searchProvider` to
 *     this provider's id. The README carries the patch.
 *  2. `available()` must not touch the network. The seam calls it cheaply and
 *     often, so it only reports whether a browser or HTTP fallback is usable.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserSearch } from './browser.js'
import { SearchMemo } from './memo.js'
import { configBoolean, modeFor, reconcile } from './settings.js'
import { applyMode, describePatch, patchPath, readPatch, writePatch } from './switch.js'
import {
  ENGINES,
  ENGINE_PREFERENCE,
  normalizeSources,
  parseHttpResults,
  preferredModeOf,
  resolveUrl,
  canonicalUrl,
} from './engines.js'

/**
 * Where this plugin keeps its own state (`boot.json`, `memo.json`, trace log).
 *
 * The location must be **the same on every run**, otherwise the diagnostics that
 * depend on it become useless. An earlier version also consulted
 * `DSH_PROFILE_DIR`, which nested the state inside the profile and produced two
 * different `boot.json` files depending on how the host was started — observed.
 *
 * `process.env.DSH_HOME` is **not** set inside the Electron host (verified: the
 * host runs with the profile directory as its cwd), so the order is: the
 * variable, then the conventional `<home>/.dsh`, then cwd as a last resort.
 */
function stateRoot() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const home = process.env.USERPROFILE ?? process.env.HOME
  if (typeof home === 'string' && home.length > 0) {
    const conventional = join(home, '.dsh')
    if (existsSync(conventional)) return conventional
  }
  // Last resort: the current directory, but only because nothing better exists.
  return process.cwd()
}

/** Directory holding this plugin's state files. */
function stateDir() {
  return join(stateRoot(), 'web-bridge')
}

/**
 * `DSH_WBRIDGE_TRACE=1` each step appends one line, so the failure has a
 * location. Off by default and never throws.
 */
/**
 * Optional boot trace.
 *
 * The host's `ctx.logger` output is not visible in a headless run, which made a
 * silent registration failure invisible: the seam reported
 * `WEB_PROVIDER_CONFIGURED_MISSING` with no clue which half broke. With
 * `DSH_WBRIDGE_TRACE=1` each step appends one line, so the failure has a
 * location. Off by default and never throws.
 */
async function traceLine(event, extra) {
  if (process.env.DSH_WBRIDGE_TRACE !== '1') return
  try {
    const { appendFileSync } = await import('node:fs')
    const target = join(stateDir(), 'wbridge-trace.log')
    mkdirSync(stateDir(), { recursive: true })
    appendFileSync(target, `${new Date().toISOString()} ${event}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}\n`)
  } catch {
    // trace must never affect the plugin
  }
}

export const name = 'web-bridge'

/** No mandatory services: the web seam is taken optionally via ctx.inject. */
export const inject = []

/**
 * Config schema, loaded dynamically.
 *
 * A static `import z from '@deepseek-ai/schemastery'` would make this module
 * unloadable by a plain `node`, which is how the self-test exercises it. If the
 * package cannot be resolved the plugin still runs; it just has no settings form.
 */
let Config
try {
  const { default: z } = await import('@deepseek-ai/schemastery')
  Config = z.object({
    providerId: z.string().default('bridge').description('id this provider registers under; the `web` entry pins it'),
    engine: z.string().default('auto').description('auto (adapt per machine) or bing | duckduckgo | marginalia | brave'),
    mode: z.string().default('auto').description('light (HTTP only, no browser process) | auto (HTTP first, browser if needed) | browser (best quality)'),
    channel: z.string().default('auto').description('browser to drive: auto | brave | edge | chrome'),
    executablePath: z.string().description('explicit browser executable; overrides `channel`'),
    headless: z.boolean().default(true).description('always keep the browser windowless'),
    idleCloseMs: z.number().default(45_000).description('close the browser after this much quiet time'),
    userDataDir: z.string().description('persistent browser profile; omit for a throwaway one'),
    maxResults: z.number().default(8).description('upper bound on returned sources'),
    timeoutMs: z.number().default(20_000).description('per-search deadline'),
    fallbackEngines: z.array(z.string()).default([]).description('extra engines tried when the primary yields nothing'),
    provenance: z.boolean().default(true).description('prepend one short line naming engine and transport'),
    // The switch, as a checkbox in the plugin's settings form. Volatile so the
    // host commits changes into the live reference and we can re-pin the seam
    // without a restart.
    useBridge: z.boolean().default(true).volatile().description('usar el puente gratuito en vez del proveedor oficial de DeepSeek'),
  })
} catch {
  Config = undefined
}
export { Config }

const DEFAULTS = {
  providerId: 'bridge',
  engine: 'auto',
  mode: 'auto',
  channel: 'auto',
  headless: true,
  idleCloseMs: 45_000,
  maxResults: 8,
  timeoutMs: 20_000,
  fallbackEngines: [],
  provenance: true,
}

/** Merge the config the host hands us over the defaults. */
function resolveOptions(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  // `useBridge` is a volatile live reference handled by the settings helpers; it
  // must not be folded into the plain options snapshot.
  const { useBridge: _switch, ...rest } = source
  const merged = {
    ...DEFAULTS,
    ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined && value !== null)),
  }
  return {
    ...merged,
    // `http` was the old name for "no browser at all"; keep it working.
    mode: merged.mode === 'http' ? 'light' : merged.mode,
    maxResults: Math.max(1, Number(merged.maxResults) || DEFAULTS.maxResults),
    timeoutMs: Math.max(2_000, Number(merged.timeoutMs) || DEFAULTS.timeoutMs),
    idleCloseMs: Math.max(0, Number(merged.idleCloseMs ?? DEFAULTS.idleCloseMs) || 0),
  }
}

/**
 * Boot marker: the answer to "did it register?" without reading logs.
 *
 * Written next to the plugin's other state and merged on each update, so after a
 * restart one small file says whether `apply` ran, what it tried, and why it
 * failed — instead of another round of guessing.
 */
function writeBoot(patch) {
  try {
    const dir = stateDir()
    const path = join(dir, 'boot.json')
    let previous = {}
    try {
      previous = JSON.parse(readFileSync(path, 'utf-8'))
    } catch {
      // first boot, or unreadable: start fresh
    }
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, `${JSON.stringify({ ...previous, ...patch, at: new Date().toISOString() }, null, 2)}\n`, 'utf-8')
  } catch {
    // A diagnostic marker must never break the plugin.
  }
}

/**
 * The order of attempts for one search.
 *
 * Two properties matter and they pull in opposite directions:
 *
 *  - **Light first.** An HTTP attempt spawns nothing; a browser attempt costs a
 *    Chromium process (~120 MB). In `auto` mode every HTTP attempt across every
 *    candidate engine is tried before the first browser is launched, so a
 *    machine where plain HTTP works never pays for a browser at all.
 *  - **Adapt, don't hardcode.** Pairs that already returned results on this
 *    machine go first; pairs that just refused are skipped for a cooldown
 *    instead of costing latency on every search.
 */
export function buildAttempts(options, memo) {
  const engines =
    options.engine === 'auto'
      ? ENGINE_PREFERENCE.slice()
      : [options.engine, ...options.fallbackEngines].filter((id, index, list) => ENGINES[id] !== undefined && list.indexOf(id) === index)

  const transports = options.mode === 'light' ? ['http'] : options.mode === 'browser' ? ['browser'] : ['http', 'browser']

  // Order: known-good pairs, then the rest, each group keeping the light-first
  // transport order.
  const attempts = []
  const seen = new Set()
  const add = (engineId, transport) => {
    if (!engines.includes(engineId)) return
    if (!transports.includes(transport)) return
    const key = `${engineId}/${transport}`
    if (seen.has(key)) return
    seen.add(key)
    attempts.push({ engineId, transport })
  }

  for (const pair of memo.working()) add(pair.engine, pair.transport)

  for (const transport of transports) {
    for (const engineId of engines) {
      if (memo.cooling(engineId, transport)) continue
      add(engineId, transport)
    }
  }

  return attempts
}

/** Fetch one engine page over plain HTTP and normalise it. */
async function searchOverHttp(engine, query, options, signal, limit) {
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const response = await fetch(engine.httpUrl(query), {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
      'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
      accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
    signal: combined,
  })
  if (!response.ok) throw new Error(`${engine.label}: HTTP ${response.status}`)
  const html = await response.text()
  const candidates = parseHttpResults(html, engine).map((entry) => ({ ...entry, url: resolveUrl(entry.url) }))
  // The bound comes from the request, not from config: the tool asks for a
  // specific number and the seam only truncates what it is given.
  // Returns `{ sources, truncated }` so the seam can report an honest cut.
  return normalizeSources(candidates, engine, limit)
}

/**
 * Build the provider object the seam registers.
 * `getOptions` is a thunk so a settings change is picked up by the next search
 * without re-registering (which would flicker the seam's selection).
 */
export function createProvider(getOptions, browser, memo) {
  const initial = getOptions()
  return {
    id: initial.providerId,

    available() {
      // Cheap and local by contract: the HTTP transport always exists, so the
      // provider is usable regardless of whether a browser was found.
      return true
    },

    async search(request, signal) {
      const options = getOptions()
      const query = String(request?.query ?? '').trim()
      if (query.length === 0) throw new Error('web-bridge: empty query')

      const requested = Number(request?.maxResults)
      const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, options.maxResults) : options.maxResults

      const attempts = buildAttempts(options, memo)
      if (attempts.length === 0) {
        throw new Error(`web-bridge: no usable engine in config (${options.engine})`)
      }

      const failures = []
      for (const { engineId, transport } of attempts) {
        if (signal?.aborted === true) throw new Error('web-bridge: aborted')
        const engine = ENGINES[engineId]
        try {
          const outcome =
            transport === 'browser'
              ? await browser.sources(engineId, query, { maxResults: limit, timeoutMs: options.timeoutMs, signal })
              : await searchOverHttp(engine, query, options, signal, limit)
          const { sources, truncated } = outcome

          if (transport === 'browser') browser.scheduleIdleClose(options.idleCloseMs)

          if (sources.length === 0) {
            memo.recordFailure(engineId, transport, 'no results')
            failures.push(`${engineId}/${transport}:0`)
            continue
          }

          memo.recordSuccess(engineId, transport)
          return {
            ...(options.provenance === true
              ? { content: `${engine.label} vía ${transport === 'browser' ? 'navegador' : 'HTTP'} — ${sources.length} resultados` }
              : {}),
            sources,
            truncated: truncated === true,
          }
        } catch (error) {
          memo.recordFailure(engineId, transport, error?.message)
          failures.push(`${engineId}/${transport}:!${String(error?.message ?? error).slice(0, 60)}`)
        }
      }

      // Returning an empty result would let the model believe the web is silent;
      // an explicit error makes the failure visible instead.
      throw new Error(`web-bridge: no results (${failures.join(', ')})`)
    },
  }
}

/** Format the seam's current state for a chat reply. */
function describeState(ctx) {
  const text = readPatch(patchPath())
  const state = describePatch(text)
  const lines = [
    `proveedor de busqueda : ${state.searchProvider ?? '(sin fijar)'}`,
    `proveedor de fetch    : ${state.fetchProvider ?? '(sin fijar)'}`,
    `oficial desactivado   : ${state.officialDisabled === undefined ? '(no declarado)' : state.officialDisabled}`,
  ]
  const web = ctx.get?.('web')
  lines.push(`seam disponible       : ${web !== undefined && web !== null ? 'si' : 'no'}`)
  return lines.join('\n')
}

/** One real search through the seam: the only honest check that a provider works. */
async function probeSeam(ctx) {
  const web = ctx.get?.('web')
  if (web === undefined || web === null || typeof web.search !== 'function') {
    return { kind: 'error', text: 'el seam `web` no esta disponible en este host' }
  }
  try {
    const result = await web.search({ query: 'deepseek harness', maxResults: 2 })
    const first = result.sources[0]
    return {
      kind: 'success',
      text: `el seam responde: ${result.sources.length} resultados\n${result.content ?? ''}\n${first === undefined ? '' : `${first.title ?? '(sin titulo)'}\n${first.url}`}`.trim(),
    }
  } catch (error) {
    return { kind: 'error', text: `el seam falla: ${String(error?.code ?? '')} ${String(error?.message ?? error)}`.trim() }
  }
}

/**
 * `/web-provider` — switch the seam between the free bridge and the official
 * provider without editing files or restarting.
 *
 * The patch is re-read live by the loader, which is what makes this a switch
 * rather than a config generation: the same mechanism that once broke
 * `web_search` (a pin applied live to a host that could not import the plugin)
 * is what makes this instant.
 */
async function handleProviderCommand(ctx, invocation) {
  const argument = String(invocation?.rawInput ?? '').trim().toLowerCase()
  const mode = argument.split(/\s+/)[0]

  try {
    if (mode === '' || mode === 'status') {
      return { kind: 'success', text: describeState(ctx) }
    }
    if (mode === 'probe' || mode === 'test') {
      return await probeSeam(ctx)
    }
    if (mode === 'bridge' || mode === 'official') {
      const path = patchPath()
      const next = applyMode(readPatch(path), mode)
      const backup = writePatch(path, next)
      const applied = describePatch(readPatch(path))
      const expected = mode === 'bridge' ? 'bridge' : 'deepseek-official'
      if (applied.searchProvider !== expected) {
        return { kind: 'error', text: `no se aplico el cambio; respaldo intacto en ${backup}` }
      }
      const note =
        mode === 'bridge'
          ? 'Puente gratuito activo (motor: navegador/HTTP segun `mode`).'
          : 'Proveedor oficial activo. Requiere saldo: sin el, web_search devuelve HTTP 402.'
      return { kind: 'success', text: `${note}\nrespaldo: ${backup}\n\n${describeState(ctx)}` }
    }
    return { kind: 'error', text: 'uso: /web-provider [status | bridge | official | probe]' }
  } catch (error) {
    return { kind: 'error', text: String(error?.message ?? error) }
  }
}

/**
 * @param ctx - host context
 * @param config - the plugin's config section
 */
export function apply(ctx, config = {}) {
  const options = resolveOptions(config)
  // First thing written: from here on, boot.json tells the story even if
  // everything below fails.
  writeBoot({ stage: 'apply', providerId: options.providerId, engine: options.engine, mode: options.mode })
  void traceLine('apply:enter', { providerId: options.providerId, engine: options.engine, mode: options.mode })

  // The command goes first and depends on nothing else: it is the escape hatch
  // when the provider misbehaves, so it must not be skipped because the browser
  // or the memo failed to construct.
  ctx.inject(['commands'], (inner) => {
    const commands = inner.commands ?? inner.get?.('commands')
    if (commands === undefined || commands === null || typeof commands.register !== 'function') {
      void traceLine('inject:commands:no-service')
      return
    }
    try {
      const dispose = commands.register({
        name: 'web-provider',
        description: 'Elige el proveedor del seam web: status | bridge | official | probe',
        handler: (invocation) => handleProviderCommand(ctx, invocation),
      })
      if (typeof dispose === 'function') ctx.effect(() => () => dispose())
      void traceLine('inject:commands:registered')
    } catch (error) {
      void traceLine('inject:commands:failed', { error: String(error?.message ?? error) })
    }
  })

  const browser = new BrowserSearch({
    channel: options.channel,
    executablePath: options.executablePath,
    headless: options.headless,
    userDataDir: options.userDataDir,
  })
  // What worked on this machine, kept next to the rest of the plugin state.
  const memo = new SearchMemo(join(stateDir(), 'memo.json'))

  // One browser process at most, and only while it is being used: closing it is
  // scheduled after `idleCloseMs` of quiet, and unloading closes it at once.
  ctx.effect(() => () => browser.close())

  // `web` mounts after plugins in a web profile, so it must be injected rather
  // than read once: a single `ctx.get('web')` would find nothing and silently
  // register no provider.
  ctx.inject(['web'], (inner) => {
    void traceLine('inject:web:fire')
    const web = inner.web ?? inner.get?.('web')
    if (web === undefined || web === null || typeof web.registerSearchProvider !== 'function') {
      void traceLine('inject:web:no-seam', { hasWeb: web !== undefined && web !== null })
      writeBoot({ stage: 'no-seam', hasWeb: web !== undefined && web !== null })
      ctx.logger?.warn?.(`${name}: web seam has no registerSearchProvider; provider not registered`)
      return
    }
    /*
     * Retry: registration is the one step that decides whether the pinned
     * provider exists at all. A single throw would leave `web_search` dead for
     * the whole session, so transient failures get a few short attempts before
     * being reported.
     */
    const attemptRegister = async () => {
      let lastError
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const provider = createProvider(() => options, browser, memo)
          const dispose = web.registerSearchProvider(provider)
          if (typeof dispose === 'function') ctx.effect(() => () => dispose())
          void traceLine('inject:web:registered', { id: provider.id, attempt })
          writeBoot({ stage: 'registered', attempt, providerId: provider.id, engine: options.engine, mode: options.mode })
          ctx.logger?.info?.(
            `${name}: registered search provider "${provider.id}" (engine=${options.engine}, mode=${options.mode}, channel=${options.channel})`,
          )
          return
        } catch (error) {
          lastError = error
          void traceLine('inject:web:register-retry', { attempt, error: String(error?.message ?? error) })
          await new Promise((resolve) => setTimeout(resolve, 400 * attempt))
        }
      }
      void traceLine('inject:web:register-failed', { error: String(lastError?.message ?? lastError) })
      writeBoot({ stage: 'register-failed', error: String(lastError?.message ?? lastError) })
      ctx.logger?.warn?.(`${name}: failed to register search provider: ${String(lastError?.message ?? lastError)}`)
    }
    void attemptRegister()
  })

  /*
   * The switch as a checkbox: `useBridge` is volatile, so the settings form
   * commits into the live config reference and announces it here. Reconciling
   * on the event (not at boot) keeps this from fighting a hand-edited patch on
   * startup — the file stays the source of truth until the user says otherwise.
   */
  try {
    ctx.on('loader/volatile-update', () => {
      try {
        const mode = modeFor(configBoolean(config, 'useBridge', true))
        const outcome = reconcile(mode)
        void traceLine('settings:reconcile', { mode, changed: outcome.changed })
        if (outcome.changed === true) {
          writeBoot({ stage: 'switched', mode, provider: outcome.provider, backup: outcome.backup })
          ctx.logger?.info?.(`${name}: web seam -> ${outcome.provider}`)
        }
      } catch (error) {
        void traceLine('settings:reconcile-failed', { error: String(error?.message ?? error) })
        writeBoot({ stage: 'switch-failed', error: String(error?.message ?? error) })
        ctx.logger?.warn?.(`${name}: no se pudo cambiar el proveedor: ${String(error?.message ?? error)}`)
      }
    })
  } catch (error) {
    void traceLine('settings:listen-failed', { error: String(error?.message ?? error) })
  }
}

/**
 * The loader unwraps `default`, so `Config` must live inside this object too —
 * exporting it only as a named binding leaves the rc.2 entry without a
 * schema-derived configuration form.
 */
export default { name, inject, Config, apply }

export { ENGINES, ENGINE_PREFERENCE, canonicalUrl, normalizeSources, parseHttpResults, preferredModeOf }
