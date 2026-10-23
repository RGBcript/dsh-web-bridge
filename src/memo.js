/**
 * Per-machine memory of what actually worked.
 *
 * Engine behaviour is not a property of this plugin: it depends on the IP, the
 * installed browser, and the day. Hardcoding "bing wins" would encode one
 * machine's measurement into every user's install. Instead the bridge records
 * which engine/transport pairs returned results, prefers those next time, and
 * cools down the ones that just refused.
 *
 * The file is small, plain JSON, and best-effort: losing it only costs one
 * rediscovery.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** How long a failure is remembered before that pair is retried. */
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000

export class SearchMemo {
  constructor(path, cooldownMs = DEFAULT_COOLDOWN_MS) {
    this.path = path
    this.cooldownMs = cooldownMs
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
    this.data[key] = { ...previous, okAt: Date.now(), failAt: previous.failAt ?? 0 }
    this.save()
  }

  recordFailure(engine, transport, reason) {
    const key = this.key(engine, transport)
    const previous = this.data[key] ?? {}
    this.data[key] = { ...previous, failAt: Date.now(), reason: String(reason ?? '').slice(0, 140) }
    this.save()
  }

  /** True when this pair is known to have worked and has not failed since. */
  healthy(engine, transport) {
    const entry = this.data[this.key(engine, transport)]
    return entry !== undefined && typeof entry.okAt === 'number' && (entry.failAt ?? 0) < entry.okAt
  }

  /** True when this pair failed recently and has not recovered since. */
  cooling(engine, transport) {
    const entry = this.data[this.key(engine, transport)]
    if (entry === undefined || typeof entry.failAt !== 'number') return false
    if (entry.failAt <= (entry.okAt ?? 0)) return false
    return Date.now() - entry.failAt < this.cooldownMs
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
