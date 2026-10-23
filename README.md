# dsh-web-bridge

Free web search for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), as a `ctx.web` provider.

**No API key. No account. No quota. No Docker.** It drives the browser you already have (or plain HTTP), reads the results page, and hands the seam a normal `WebSearchResult`.

The built-in `deepseek-official` provider bills every search against your DeepSeek balance. When that balance is empty, `web_search` fails with `HTTP 402 Insufficient Balance` and the model is left improvising with `web_fetch`. This plugin exists to replace that path.

## Why another one

There are hundreds of `dsh-web-search-*` packages. The honest comparison:

| | Requires a key | Requires Docker | Requires a LAN service | Drives a real browser |
| --- | --- | --- | --- | --- |
| `deepseek-official` (built in) | yes (balance) | no | no | no |
| Tavily / Brave / Exa / Serper backends | **yes** | no | no | no |
| SearXNG backends | no | **yes** | yes | no |
| **dsh-web-bridge** | **no** | **no** | **no** | yes, optional |

The trade is explicit: a key-based provider gives you ranked, aggregated results; this one gives you **whatever a public search page shows**, at zero cost. If you need semantic ranking, use a keyed provider. If you need search to keep working when the balance does not, this is the other side of the trade.

It is not a metasearch engine. It picks one engine, tries HTTP first, and only launches a browser when the HTTP page yields nothing usable.

## Measured behaviour

Verified on Windows 11 with Brave 155, DSH `0.2.1-rc.2`. These are observations on one network from one region — treat them as a starting point, not a guarantee:

| Engine | HTTP | Browser (headless) | Notes |
| --- | --- | --- | --- |
| **Bing** | works | works | 15 destination URLs extracted per page; most reliable here |
| **DuckDuckGo** (HTML) | works, sometimes captcha | shell only | captcha appears under load |
| **Marginalia** | works | — | small independent index; few but clean results |
| **Brave Search** | challenge | challenge | needs a session cookie; off by default |
| **Exa** (semantic) | API | — | last resort, only when every lexical engine returns nothing |
| Google | blocked | renders, 0 extractable URLs | not supported |

### Why a semantic engine, and why last

The lexical engines match words. Ask for "Gemini Argon" when the documents say "Gemini 4 Argon" and DuckDuckGo returns *nothing* — the tokens do not overlap, so there is no match to rank. Measured directly: the same query with the `4` returned four results, without it zero.

Exa ranks by meaning, so the vague question still finds the page. It is the only keyless semantic source that works from here: public SearXNG instances now answer `403` or HTML where JSON was expected, and OpenAlex only indexes papers.

It runs **last**, after every lexical attempt, for two measured reasons:

- **Latency.** 1.5–5.6 s per call against ~1 s for a lexical engine.
- **Rate.** Five concurrent calls produced two `429`s; spacing them 3 s apart produced none.

The endpoint is serialised by an internal mutex, and a `429` is reported as `WEB_RATE_LIMITED`, never as an empty result — a rejected call returns a non-JSON body that would otherwise read as "nothing found". Repeated failures put the engine in the same cooldown a failing lexical engine gets.

No API key, no account, no cost. The public endpoint is a courtesy service with no SLA; if it disappears, the lexical path keeps working unchanged.

`memo.json` remembers which engine/transport pair actually returned results on your machine and prefers it, so the plugin adapts instead of hardcoding one engine.

## Install

```sh
dsh plugin --profile <profile> add dsh-web-bridge
```

Then point the seam at it in that profile's `cordis.patch.yml`:

```yaml
- id: web
  config:
    searchProvider: bridge
    fetchProvider: http
```

`fetchProvider: http` matters: with two usable fetch providers and no pin, `web_fetch` fails with an ambiguity error.

**Restart after installing.** The set of mounted entries is composed at boot (`cordis.yml`) and is not recomputed later. Changing the *config* of an entry that is already mounted does apply live; adding one does not.

If your profile does not pick up the bundle patch — it happens on Windows Electron builds — declare the entry explicitly instead:

```yaml
- insert:
    - id: web-bridge
      name: dsh-web-bridge
      config:
        providerId: bridge
```

A bare `- id: web-bridge` at the top level only *patches* an entry that already exists; it does not create one.

## Configuration

All fields are optional; the defaults are what the measurements above used.

| Field | Default | Meaning |
| --- | --- | --- |
| `providerId` | `bridge` | id this provider registers under; the `web` entry pins it |
| `engine` | `auto` | `auto`, or one of `bing` `duckduckgo` `marginalia` `brave` |
| `mode` | `auto` | `light` (HTTP only, never spawns a process) · `auto` (HTTP first, browser if empty) · `browser` |
| `channel` | `auto` | which browser to drive: `auto` `brave` `edge` `chrome` |
| `executablePath` | — | explicit browser binary, overrides `channel` |
| `headless` | `true` | keep the window hidden |
| `idleCloseMs` | `45000` | close the browser after this much quiet |
| `userDataDir` | — | persistent browser profile; omit for a throwaway one |
| `maxResults` | `8` | upper bound on returned sources |
| `timeoutMs` | `20000` | per-search deadline |
| `fallbackEngines` | `[]` | extra engines tried when the primary yields nothing |
| `provenance` | `true` | prepend one line naming engine and transport |
| `useBridge` | `true` | settings checkbox that flips the seam between this and `deepseek-official` |

### The browser is optional

`mode: light` never launches a process. In `auto`, every HTTP attempt across every candidate engine runs before the first browser is spawned, so a machine where HTTP works never pays for Chromium at all. Measured cost when a browser *is* used: 6 processes and ~410 MB while alive, 0 after it closes.

## Tools

The `tools/` directory is the part that makes failures diagnosable instead of mysterious.

```sh
node tools/env-doctor.mjs        # is each installed plugin compatible with THIS runtime?
node tools/preflight.mjs         # is the profile ready? run before restarting
node tools/rollback.mjs          # switch provider without DSH, if the plugin cannot load
node tools/selftest.mjs          # end-to-end search against live engines
node tools/engine-matrix.mjs     # which engines work on this network
node tools/footprint.mjs         # process count and RAM of one search
```

`env-doctor` exists because `dsh --dump-config` cannot see one thing: the **plugin manager's compatibility gate**, which only runs inside Electron. A plugin with a peer pinned to an older version is silently vetoed — installable, declared, importable, and never mounted. `env-doctor` reimplements that gate from the host's own rules.

## What this plugin does not do

- **No ranking or aggregation.** One engine per search, no merging of several result sets.
- **No JS-rendered pages** in `light` mode. That is what the browser mode is for.
- **No authenticated content.** Paywalls, logins and social platforms are out of reach.
- **No proxy support.**
- **Not a `web_fetch` replacement.** It pins `fetchProvider: http`, which is a different provider.

## License

MIT. This plugin reads public result pages; whether that is acceptable is your call and may depend on the terms of the sites involved.
