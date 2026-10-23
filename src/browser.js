/**
 * Real-browser search backend over the Chrome DevTools Protocol.
 *
 * Why a browser at all: an HTTP fetch of a search page sees the markup a server
 * chose to send. A browser sees the page after its own scripts ran, which is
 * where most results, snippets and answer boxes actually live. The bridge keeps
 * both paths and prefers the browser; HTTP stays as the fallback for machines
 * without one.
 *
 * The browser is launched lazily and reused across searches — a cold Chromium
 * start costs more than the search itself. It runs headless by default and with
 * its own profile directory, so it never touches, locks, or steals focus from
 * the user's own browser window.
 *
 * Nothing here imports a harness package: this module must stay loadable by a
 * plain `node` for the probe and tests.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENGINES, normalizeSources } from './engines.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Known browser locations, in the order a user on Windows most likely has them.
 * Brave comes first because it is what this user runs.
 */
function candidatePaths() {
  const programFiles = process.env.PROGRAMFILES ?? 'C:/Program Files'
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)'
  const localAppData = process.env.LOCALAPPDATA ?? ''
  return [
    { channel: 'brave', path: join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') },
    { channel: 'brave', path: join(programFilesX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') },
    { channel: 'brave', path: join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') },
    { channel: 'edge', path: join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { channel: 'edge', path: join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { channel: 'chrome', path: join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { channel: 'chrome', path: join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { channel: 'chromium', path: join(localAppData, 'Chromium', 'Application', 'chrome.exe') },
  ]
}

/**
 * Resolve which browser to drive.
 * An explicit path wins; otherwise the first installed known channel.
 */
export function resolveBrowser(options = {}) {
  if (typeof options.executablePath === 'string' && options.executablePath.length > 0) {
    if (!existsSync(options.executablePath)) {
      return { error: `browserExecutablePath does not exist: ${options.executablePath}` }
    }
    return { path: options.executablePath, channel: options.channel ?? 'custom' }
  }
  const wanted = options.channel
  for (const candidate of candidatePaths()) {
    if (typeof wanted === 'string' && wanted !== 'auto' && candidate.channel !== wanted) continue
    if (existsSync(candidate.path)) return candidate
  }
  return { error: wanted && wanted !== 'auto' ? `no ${wanted} installation found` : 'no supported browser found' }
}

/** Minimal CDP session over the page target's websocket. */
async function openSocket(wsUrl) {
  const socket = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map()
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true })
  })
  socket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    if (message.error !== undefined) entry.reject(new Error(`${entry.method}: ${message.error.message}`))
    else entry.resolve(message.result)
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId
      nextId += 1
      pending.set(id, { resolve, reject, method })
      socket.send(JSON.stringify({ id, method, params }))
    })
  return {
    send,
    close: () => {
      try {
        socket.close()
      } catch {
        // already gone
      }
    },
  }
}

/**
 * One browser process, reused across searches.
 *
 * `available()` must never touch the network (the seam asks it cheaply), so the
 * usability check is just "an executable was found".
 */
export class BrowserSearch {
  constructor(options = {}) {
    this.options = options
    this.child = undefined
    this.socket = undefined
    this.starting = undefined
    this.resolved = undefined
  }

  /** Cheap local check: is a browser configured or discoverable? */
  available() {
    return this.resolve().error === undefined
  }

  resolve() {
    if (this.resolved === undefined) this.resolved = resolveBrowser(this.options)
    return this.resolved
  }

  /** Launch (once) and attach. Concurrent callers share one start. */
  async ensure() {
    if (this.socket !== undefined) return this.socket
    if (this.starting !== undefined) return await this.starting
    this.starting = this.start()
    try {
      this.socket = await this.starting
      return this.socket
    } finally {
      this.starting = undefined
    }
  }

  async start() {
    const resolved = this.resolve()
    if (resolved.error !== undefined) throw new Error(resolved.error)

    const port = this.options.debugPort ?? 9333 + Math.floor(Math.random() * 200)
    const userDataDir = this.options.userDataDir ?? join(tmpdir(), `dsh-web-bridge-${process.pid}`)
    mkdirSync(userDataDir, { recursive: true })

    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-default-apps',
      '--mute-audio',
      '--window-size=1280,900',
    ]

    /*
     * Lean flags. A stock Chromium start measured ~7 processes and ~500 MB on
     * this machine, which defeats the point of a search backend that is supposed
     * to stay in the background. Rendering a text SERP needs no GPU, one
     * renderer at most, and no shared-memory fallback dance.
     */
    if (this.options.lean !== false) {
      args.push(
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-dev-shm-usage',
        '--renderer-process-limit=1',
        '--disable-features=Translate,MediaRouter,OptimizationHints,BackForwardCache',
        '--js-flags=--max-old-space-size=256',
      )
    }

    args.push('about:blank')
    if (this.options.headless !== false) args.unshift('--headless=new')

    this.child = spawn(resolved.path, args, { stdio: 'ignore', windowsHide: true })

    // Poll for a page target; the browser needs a moment to open the port.
    const deadline = Date.now() + (this.options.launchTimeoutMs ?? 20_000)
    let target
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`)
        const targets = await response.json()
        target = targets.find((entry) => entry.type === 'page' && typeof entry.webSocketDebuggerUrl === 'string')
        if (target !== undefined) break
      } catch {
        // still starting
      }
      await sleep(250)
    }
    if (target === undefined) throw new Error(`browser did not expose a page target on port ${port}`)

    const socket = await openSocket(target.webSocketDebuggerUrl)
    await socket.send('Page.enable')
    await socket.send('Runtime.enable')
    return socket
  }

  /**
   * Run one search through the engine's rendered page.
   * @returns raw candidates; the caller normalises them.
   */
  async search(engineId, query, { timeoutMs = 20_000 } = {}) {
    const engine = ENGINES[engineId]
    if (engine === undefined) throw new Error(`unknown engine: ${engineId}`)
    const socket = await this.ensure()

    await socket.send('Page.navigate', { url: engine.browserUrl(query) })

    // Wait for the document, then for the engine's own results to appear. The
    // settle window is what makes the difference against a plain fetch: scripts
    // inject the result list after load.
    const deadline = Date.now() + timeoutMs
    let ready = false
    while (Date.now() < deadline) {
      try {
        const state = await socket.send('Runtime.evaluate', {
          expression: 'document.readyState',
          returnByValue: true,
        })
        if (state.result?.value === 'complete') {
          ready = true
          break
        }
      } catch {
        // navigation in flight
      }
      await sleep(200)
    }
    if (!ready) throw new Error(`${engine.label}: page did not finish loading`)

    await sleep(engine.settleMs ?? 1200)

    // Best-effort dismissal of consent overlays that would hide results.
    try {
      await socket.send('Runtime.evaluate', {
        expression: `(() => {
          const labels = /^(accept|aceptar|acepto|agree|consent|allow all|permitir todo|reject all|rechazar todo)$/i;
          for (const node of document.querySelectorAll('button, [role="button"]')) {
            const text = (node.innerText || '').trim();
            if (labels.test(text)) { try { node.click(); } catch {} }
          }
          return true;
        })()`,
        returnByValue: true,
      })
      await sleep(400)
    } catch {
      // A consent banner is best-effort; results may already be there.
    }

    const extracted = await socket.send('Runtime.evaluate', {
      expression: `(${engine.extract.toString()})()`,
      returnByValue: true,
      awaitPromise: false,
    })
    if (extracted.exceptionDetails !== undefined) {
      throw new Error(`${engine.label}: extraction failed: ${extracted.exceptionDetails.text}`)
    }
    const candidates = Array.isArray(extracted.result?.value) ? extracted.result.value : []
    return { engine, candidates, finalUrl: await this.currentUrl(socket) }
  }

  async currentUrl(socket) {
    try {
      const value = await socket.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })
      return typeof value.result?.value === 'string' ? value.result.value : ''
    } catch {
      return ''
    }
  }

  /**
   * Normalised sources, ready for the seam.
   *
   * `signal` is honoured: the seam passes a per-search abort signal, and a
   * cancelled search must not keep a Chromium navigation alive. Checked before
   * the work starts and once it returns, which is enough because the underlying
   * navigation already has its own deadline.
   */
  async sources(engineId, query, { maxResults, timeoutMs, signal } = {}) {
    if (signal?.aborted === true) throw new Error('web-bridge: aborted')
    const { engine, candidates } = await this.search(engineId, query, { timeoutMs })
    if (signal?.aborted === true) throw new Error('web-bridge: aborted')
    return { ...normalizeSources(candidates, engine, maxResults), candidates, engine }
  }

  /**
   * Close the browser after a quiet period.
   *
   * A Chromium instance costs ~120 MB while it lives. Keeping it forever turns a
   * search plugin into a permanent background process; closing it immediately
   * throws away the startup cost between two quick searches. The idle window is
   * that trade, and `unref` means it never holds the host process open.
   */
  scheduleIdleClose(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      this.close()
    }, ms)
    this.idleTimer.unref?.()
  }

  close() {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
    try {
      this.socket?.close()
    } catch {
      // ignore
    }
    this.socket = undefined
    if (this.child !== undefined) {
      try {
        this.child.kill()
      } catch {
        // already exited
      }
      this.child = undefined
    }
  }
}
