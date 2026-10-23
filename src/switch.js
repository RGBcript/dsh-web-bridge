/**
 * Switching the web seam's search provider, in place.
 *
 * Why this exists: `WebRuntimeConfig.searchProvider` is read from the profile
 * patch, and the harness applies profile patch edits LIVE (verified: reverting a
 * pin took effect without a restart). So switching providers is a two-line file
 * edit, not a restart — as long as the edit is surgical.
 *
 * The risk here is a hand-edited YAML file, so the rules are:
 *  - only ever touch two known keys, preserving everything else byte for byte;
 *  - write through a temporary file and rename, so the loader never reads a
 *    half-written patch;
 *  - keep a timestamped backup before each change, and offer a revert;
 *  - refuse to run when the profile directory is unknown rather than guessing.
 */
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const ENTRY_WEB = 'web'
export const ENTRY_OFFICIAL = 'web-search-deepseek'

/** Absolute path to the profile patch, or undefined when it cannot be located. */
export function patchPath() {
  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir !== 'string' || profileDir.length === 0) return undefined
  return join(profileDir, 'cordis.patch.yml')
}

/** Index range [start, end) of a top-level `- id: <entry>` block. */
function blockRange(lines, entryId) {
  const startPattern = new RegExp(`^-[ \\t]*id:[ \\t]*${entryId}[ \\t]*$`)
  const start = lines.findIndex((line) => startPattern.test(line))
  if (start === -1) return undefined
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    // A new top-level entry starts a new block.
    if (/^-/.test(lines[index])) {
      end = index
      break
    }
  }
  return { start, end }
}

/** Current state as seen by a human: provider id and whether the official entry is off. */
export function describePatch(text) {
  const lines = text.split('\n')
  const web = blockRange(lines, ENTRY_WEB)
  let searchProvider
  let fetchProvider
  if (web !== undefined) {
    for (let index = web.start; index < web.end; index += 1) {
      const match = lines[index].match(/^\s+searchProvider:\s*(\S+)\s*$/)
      if (match !== null) searchProvider = match[1]
      const fetchMatch = lines[index].match(/^\s+fetchProvider:\s*(\S+)\s*$/)
      if (fetchMatch !== null) fetchProvider = fetchMatch[1]
    }
  }
  const official = blockRange(lines, ENTRY_OFFICIAL)
  let officialDisabled
  if (official !== undefined) {
    for (let index = official.start; index < official.end; index += 1) {
      const match = lines[index].match(/^\s+disabled:\s*(true|false)\s*$/)
      if (match !== null) officialDisabled = match[1] === 'true'
    }
  }
  return { searchProvider, fetchProvider, officialDisabled, hasWebBlock: web !== undefined, hasOfficialBlock: official !== undefined }
}

/**
 * Set (or insert) `searchProvider` inside the `web` entry block.
 * The block's own indentation is reused so a 2- or 4-space file both survive.
 */
export function setSearchProvider(text, providerId) {
  const lines = text.split('\n')
  const web = blockRange(lines, ENTRY_WEB)
  if (web === undefined) throw new Error(`no "${ENTRY_WEB}" entry in the profile patch`)

  for (let index = web.start; index < web.end; index += 1) {
    if (/^\s+searchProvider:/.test(lines[index])) {
      const indent = lines[index].match(/^\s*/)[0]
      lines[index] = `${indent}searchProvider: ${providerId}`
      return lines.join('\n')
    }
  }

  // Not present: insert right after the entry's `config:` line, else after the id.
  let insertAt = web.start + 1
  for (let index = web.start; index < web.end; index += 1) {
    if (/^\s+config:\s*$/.test(lines[index])) {
      insertAt = index + 1
      break
    }
  }
  const indent = `${(lines[web.start].match(/^\s*/) ?? [''])[0]}  `
  const keyIndent = `${indent}  `
  lines.splice(insertAt, 0, `${keyIndent}searchProvider: ${providerId}`)
  return lines.join('\n')
}

/**
 * Set `disabled` on an entry, appending the entry when it is missing.
 * Appending uses the same shape as the rest of the file.
 */
export function setEntryDisabled(text, entryId, disabled) {
  const lines = text.split('\n')
  const block = blockRange(lines, entryId)
  if (block !== undefined) {
    for (let index = block.start; index < block.end; index += 1) {
      if (/^\s+disabled:/.test(lines[index])) {
        const indent = lines[index].match(/^\s*/)[0]
        lines[index] = `${indent}disabled: ${disabled}`
        return lines.join('\n')
      }
    }
    lines.splice(block.start + 1, 0, `  disabled: ${disabled}`)
    return lines.join('\n')
  }
  const trailingNewline = text.endsWith('\n') ? '' : '\n'
  return `${text}${trailingNewline}- id: ${entryId}\n  disabled: ${disabled}\n`
}

/** Write the patch atomically, keeping a timestamped backup first. */
export function writePatch(path, text) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${path}.bak-web-provider-${stamp}`
  copyFileSync(path, backup)
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, text, 'utf-8')
  renameSync(temporary, path)
  return backup
}

/** Read the patch, or throw a message that tells the caller what to do. */
export function readPatch(path) {
  if (path === undefined) {
    throw new Error('DSH_PROFILE_DIR is not set, so the profile patch cannot be located')
  }
  if (!existsSync(path)) throw new Error(`no profile patch at ${path}`)
  return readFileSync(path, 'utf-8')
}

/**
 * Apply one mode to the patch text.
 * `bridge` is the free provider; `official` restores DeepSeek (needs balance).
 */
export function applyMode(text, mode) {
  if (mode === 'bridge') {
    const withProvider = setSearchProvider(text, 'bridge')
    return setEntryDisabled(withProvider, ENTRY_OFFICIAL, true)
  }
  if (mode === 'official') {
    const withProvider = setSearchProvider(text, 'deepseek-official')
    return setEntryDisabled(withProvider, ENTRY_OFFICIAL, false)
  }
  throw new Error(`unknown mode "${mode}"; expected bridge or official`)
}
