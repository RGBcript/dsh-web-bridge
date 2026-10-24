/**
 * Per-machine memory of what actually worked.
 *
 * Engine behaviour is not a property of this plugin: it depends on the IP, the
 * installed browser, and the day. Hardcoding "bing wins" would encode one
 * machine's measurement into every user's install. Instead the bridge records
 * which engine/transport pairs returned results, prefers those next time, and
 * cools down the ones that just refused.
 *
 * ## Why the cooldown depends on the failure
 *
 * A single fixed penalty was wrong in both directions, observed on a real
 * session: a half-hour burst of 122 fetches earned DuckDuckGo a captcha, and the
 * old 10-minute blanket cooldown kept it benched long after the captcha had
 * cleared — DuckDuckGo answered normally again within a minute when tested
 * directly. Meanwhile a genuine "this engine has no index for that query" should
 * not be retried every minute either.
 *
 * So the penalty is proportional to what went wrong:
 *
 * | kind      | meaning                                   | bench  |
 * |-----------|-------------------------------------------|--------|
 * | `empty`   | answered, but with no usable results       | 10 min |
 * | `captcha` | served a bot challenge                     | 60 s   |
 * | `rate`    | 429 / quota                                | 5 min  |
 * | `network` | timeout, DNS, connection reset             | 90 s   |
 *
 * The file is small, plain JSON, and best-effort: losing it only costs one
 * rediscovery.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Bench time per failure kind, in milliseconds. */
export const COOLDOWNS = {
  /** Answered, but nothing usable came back. Retrying soon would not help. */
  empty: 10 * 60 * 1000,
  /** A bot challenge. Clears quickly once the burst stops. */
  captcha: 60 * 1000,
  /** Explicit rate limit: the endpoint asked us to slow down. */
  rate: 5 * 60 * 1000,
  /** Transport-level failure: worth retrying shortly. */
  network: 90 * 1000,
}

/**
 * Benchmark used for entries written before `kind` existed.
 *
 * Those entries carry only a free-form `reason` string. Treating them as `empty`
 * preserves the previous behaviour exactly, so an old file keeps working instead
 * of suddenly retrying everything.
 */
const LEGACY_COOLDOWN_MS = COOLDOWNS.empty

/** Kinds this module understands; anything else is recorded as `empty`. */
export const FAILURE_KINDS = new Set(Object.keys(COOLDOWNS))

/**
 * Classify a failure from the error/message the caller saw.
 *
 * Kept here, next to the cooldowns, so the mapping between "what happened" and
 * "how long to wait" is readable in one place. A caller that already knows the
 * kind may pass it directly.
 */
export function classifyFailure(value) {
  if (typeof value === 'string' && FAILURE_KINDS.has(value)) return value
  const text = String(value?.code ?? value?.message ?? value ?? '').toLowerCase()
  if (text.includes('rate_limited') || text.includes('429') || text.includes('rate limited')) return 'rate'
  if (text.includes('captcha') || text.includes('challenge') || text.includes('anomaly')) return 'captcha'
  if (text.includes('timeout') || text.includes('aborted') || text.includes('abort')) return 'network'
  if (text.includes('econn') || text.includes('enotfound') || text.includes('fetch failed') || text.includes('socket')) return 'network'
  return 'empty'
}

export class SearchMemo {
  /**
   * @param path - JSON file this memo lives in.
   * @param cooldownMs - overrides every per-kind value; used by tests and by
   *   callers that want one uniform penalty.
   */
  constructor(path, cooldownMs) {
    this.path = path
    this.cooldownMs = typeof cooldownMs === 'number' ? cooldownMs : undefined
    this.data = this.load()
  }

  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8'))
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  save() {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, `${JSON.stringify(this.data, null, 2)}\n`, 'utf-8')
    } catch {
      // A memo that cannot be written must never break a search.
    }
  }

  key(engine, transport) {
    return `${engine}/${transport}`
  }

  recordSuccess(engine, transport) {
    const key = this.key(engine, transport)
    const previous = this.data[key] ?? {}
    // `kind` is cleared on success: the pair is healthy again, and a stale kind
    // would describe a failure that no longer applies.
    this.data[key] = { okAt: Date.now(), failAt: previous.failAt ?? 0 }
    this.save()
  }

  recordFailure(engine, transport, failure) {
    const key = this.key(engine, transport)
    const previous = this.data[key] ?? {}
    const kind = classifyFailure(failure)
    this.data[key] = {
      ...previous,
      failAt: Date.now(),
      kind,
      // Human-readable detail, truncated: the kind drives behaviour, this only
      // helps when someone opens the file.
      reason: String(failure?.message ?? failure ?? '').slice(0, 140),
    }
    this.save()
  }

  /** True when this pair is known to have worked and has not failed since. */
  healthy(engine, transport) {
    const entry = this.data[this.key(engine, transport)]
    return entry !== undefined && typeof entry.okAt === 'number' && (entry.failAt ?? 0) < entry.okAt
  }

  /** How long this entry is benched, in ms. Legacy entries use the default. */
  cooldownFor(entry) {
    if (this.cooldownMs !== undefined) return this.cooldownMs
    if (entry === undefined) return LEGACY_COOLDOWN_MS
    const kind = entry.kind
    if (typeof kind === 'string' && Object.hasOwn(COOLDOWNS, kind)) return COOLDOWNS[kind]
    return LEGACY_COOLDOWN_MS
  }

  /** True when this pair failed recently and has not recovered since. */
  cooling(engine, transport) {
    const entry = this.data[this.key(engine, transport)]
    if (entry === undefined || typeof entry.failAt !== 'number') return false
    if (entry.failAt <= (entry.okAt ?? 0)) return false
    return Date.now() - entry.failAt < this.cooldownFor(entry)
  }

  /** Working pairs, most recently successful first. */
  working() {
    return Object.entries(this.data)
      .filter(([, entry]) => typeof entry.okAt === 'number' && (entry.failAt ?? 0) < entry.okAt)
      .sort((left, right) => right[1].okAt - left[1].okAt)
      .map(([key]) => {
        const [engine, transport] = key.split('/')
        return { engine, transport }
      })
  }
}
