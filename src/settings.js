/**
 * Settings helpers: the switch as a checkbox instead of a command.
 *
 * A `.volatile()` field in the exported `Config` is handed to `apply` as a live
 * reference: the loader commits a settings-only change into that reference in
 * place and announces it as `loader/volatile-update`, without remounting the
 * plugin. That is what makes a settings checkbox able to re-pin the web seam
 * with no restart — the same live-config property that once broke `web_search`
 * when a pin outran its plugin.
 *
 * Everything here is defensive: a failure to reconcile must never take down the
 * provider, because the plugin's main job is searching, not switching.
 */
import { applyMode, describePatch, patchPath, readPatch, writePatch } from './switch.js'

/** cosmokit's shared live-reference protocol, identified across duplicate installs. */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** Whether a parsed config value is one of the schema's live references. */
export function isVolatileRef(value) {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value
}

/** Read one config field as a plain value, live reference or not. */
export function configValue(config, key, fallback) {
  if (config === undefined || config === null) return fallback
  const raw = Reflect.get(config, key)
  if (raw === undefined || raw === null) return fallback
  if (isVolatileRef(raw)) {
    const snapshot = raw.get()
    return snapshot === undefined ? fallback : snapshot
  }
  return raw
}

/** Read one config field expected to be a boolean. */
export function configBoolean(config, key, fallback) {
  const value = configValue(config, key, undefined)
  return typeof value === 'boolean' ? value : fallback
}

/** The mode a given `useBridge` value means. */
export function modeFor(useBridge) {
  return useBridge === false ? 'official' : 'bridge'
}

/** True when the patch already points the seam at the mode's provider. */
export function patchMatches(text, mode) {
  const state = describePatch(text)
  if (mode === 'bridge') return state.searchProvider === 'bridge' && state.officialDisabled === true
  return state.searchProvider === 'deepseek-official' && state.officialDisabled === false
}

/**
 * Bring the patch in line with the checkbox.
 *
 * Called after the settings commit, then re-reads the file: the settings service
 * has just written the same file, so acting on a stale read would undo its work.
 * Returns a short description of what happened, or throws when the write cannot
 * be confirmed.
 */
export function reconcile(mode) {
  const path = patchPath()
  const current = readPatch(path)
  if (patchMatches(current, mode)) return { changed: false, mode }

  const next = applyMode(current, mode)
  const backup = writePatch(path, next)
  const applied = describePatch(readPatch(path))
  if (!patchMatches(readPatch(path), mode)) {
    throw new Error(`no se pudo confirmar el cambio a ${mode} (respaldo: ${backup})`)
  }
  return { changed: true, mode, backup, provider: applied.searchProvider }
}
