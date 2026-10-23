/**
 * What does the browser mode actually cost?
 *
 * "One browser process" is misleading for anyone who looks at Task Manager:
 * Chromium is multi-process, so a single search shows a parent plus renderer,
 * GPU, network and utility children. This measures the real footprint on THIS
 * machine — process count and working set — and then proves it goes back to zero
 * when the idle close fires.
 *
 *   node tools/footprint.mjs [--channel brave] [--keep]
 *
 * `--keep` leaves the browser running so the processes can be inspected by hand.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserSearch, resolveBrowser } from '../src/browser.js'

const argv = process.argv.slice(2)
const option = (flag, fallback) => {
  const index = argv.indexOf(`--${flag}`)
  return index === -1 ? fallback : argv[index + 1]
}
const channel = option('channel', 'auto')
const keep = argv.includes('--keep')

// A unique token in the profile path is what makes the process filter exact: it
// can never match the user's own browser, which is running in parallel.
const token = `dsh-web-bridge-${randomUUID().slice(0, 8)}`
const userDataDir = join(tmpdir(), token)

const resolved = resolveBrowser({ channel })
console.log(`navegador : ${resolved.error ?? `${resolved.channel} -> ${resolved.path}`}`)
console.log(`perfil    : ${userDataDir}`)
console.log(`token     : ${token}\n`)

/**
 * Every OS process whose command line carries our unique profile token.
 *
 * The filter also pins the image name. Without it the measuring PowerShell
 * matched its own command line (the token is part of the script text) and the
 * baseline read "1 process, 75 MB" — the shell itself.
 */
function measure(token, exeName) {
  const script = `
$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -eq '${exeName}' -and $_.CommandLine -like '*${token}*' }
$total = ($procs | Measure-Object -Property WorkingSetSize -Sum).Sum
[pscustomobject]@{
  count = @($procs).Count
  mb = if ($total) { [math]::Round($total / 1MB, 1) } else { 0 }
} | ConvertTo-Json -Compress
`
  try {
    const raw = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf-8',
      windowsHide: true,
    }).trim()
    return JSON.parse(raw)
  } catch {
    return { count: -1, mb: -1 }
  }
}

const exeName = resolved.error === undefined ? resolved.path.split(/[\\/]/).pop() : ''
const lean = argv.includes('--no-lean') === false
console.log(`modo ligero : ${lean ? 'si (--disable-gpu, 1 renderer)' : 'no'}\n`)

const before = measure(token, exeName)
console.log(`antes de buscar : ${before.count} procesos, ${before.mb} MB`)

const browser = new BrowserSearch({ channel, headless: true, userDataDir, lean })
const started = Date.now()
let sources = 0
try {
  const outcome = await browser.sources('bing', 'deepseek harness', { maxResults: 5 })
  sources = outcome.sources.length
} catch (error) {
  console.log(`  (la busqueda fallo: ${String(error.message).slice(0, 70)})`)
}
const elapsed = Date.now() - started

const during = measure(token, exeName)
console.log(`buscando        : ${sources} resultados en ${elapsed} ms`)
console.log(`mientras vive   : ${during.count} procesos, ${during.mb} MB`)

if (keep) {
  console.log('\n--keep: el navegador sigue vivo; inspecciona y matalo a mano')
  process.exit(0)
}

// The plugin's own idle close, with a short window so the check is quick.
browser.scheduleIdleClose(1500)
await new Promise((resolve) => setTimeout(resolve, 3500))

const after = measure(token, exeName)
console.log(`tras cerrar     : ${after.count} procesos, ${after.mb} MB`)

const closed = after.count === 0
console.log(`\n== cierre: ${during.count} -> ${after.count} procesos (${closed ? 'OK' : 'FALLO'}) ==`)
process.exit(closed ? 0 : 1)
