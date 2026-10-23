/**
 * Locating the DSH installation on any machine.
 *
 * Every tool in this package used to hardcode `C:/Users/GUERRA/...`, which works
 * for exactly one person. This module resolves the same locations from the
 * environment first, then from the documented defaults, so the package can be
 * published and used by anyone.
 *
 * Resolution order, per value:
 *   1. an explicit environment variable or CLI flag,
 *   2. the standard location for the platform,
 *   3. `undefined` — callers decide whether that is fatal.
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/** The user's home directory, cross-platform. */
export function homeDir() {
  const home = process.env.USERPROFILE ?? process.env.HOME
  if (typeof home === 'string' && home.length > 0) return home
  throw new Error('cannot determine the home directory (USERPROFILE/HOME are unset)')
}

/** `DSH_HOME`: the harness state directory holding `profiles/`, `skills/`, etc. */
export function dshHome(explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const conventional = join(homeDir(), '.dsh')
  if (existsSync(conventional)) return conventional
  return conventional
}

/** Directory of one profile inside `DSH_HOME`. */
export function profileDir(profile = 'desktop', home) {
  return join(dshHome(home), 'profiles', profile)
}

/**
 * Candidate roots for the Electron application's `resources` directory.
 * `DSH_APP_ROOT` wins, so a custom install (or a test) can point elsewhere.
 */
export function appRoots() {
  const roots = []
  const explicit = process.env.DSH_APP_ROOT
  if (typeof explicit === 'string' && explicit.length > 0) roots.push(explicit)
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? (() => {
      try {
        return join(homeDir(), 'AppData', 'Local')
      } catch {
        return undefined
      }
    })()
    if (typeof local === 'string' && local.length > 0) {
      roots.push(join(local, 'Programs', 'DeepSeek Harness', 'resources'))
    }
  } else if (process.platform === 'darwin') {
    roots.push('/Applications/DeepSeek Harness.app/Contents/Resources')
  } else {
    roots.push('/opt/DeepSeek Harness/resources', '/usr/lib/deepseek-harness/resources')
  }
  return roots
}

/**
 * `package.json` files that can resolve harness packages and `semver`/`js-yaml`.
 * These live with the npm-installed `dsh` package, not in a profile.
 */
export function harnessPackageRoots() {
  const roots = []
  const explicit = process.env.DSH_HARNESS_PACKAGE
  if (typeof explicit === 'string' && explicit.length > 0) roots.push(explicit)
  try {
    if (process.platform === 'win32') {
      const roaming = process.env.APPDATA ?? join(homeDir(), 'AppData', 'Roaming')
      roots.push(join(roaming, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    } else {
      roots.push('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json')
      roots.push(join(homeDir(), '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    }
  } catch {
    // no home: the explicit variable is the only option
  }
  for (const root of appRoots()) roots.push(join(root, 'app.asar.unpacked', 'package.json'))
  return roots.filter((path) => {
    try {
      return existsSync(path)
    } catch {
      return false
    }
  })
}

/**
 * Load one module from the first harness root that can resolve it.
 * Returns `undefined` when nothing resolves it — callers must handle that
 * instead of silently skipping a check.
 */
export function loadFromHarness(name) {
  for (const base of harnessPackageRoots()) {
    try {
      return createRequire(base)(name)
    } catch {
      // next candidate
    }
  }
  return undefined
}
