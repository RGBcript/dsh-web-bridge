/**
 * Tests del extractor HTTP.
 *
 * Existen por un fallo concreto y silencioso: Bing servía una página correcta con
 * 10 resultados, pero cada `href` era un redirector `bing.com/ck/a?p=<hex>`. El
 * escaneo genérico de anclas devolvía 22 candidatos, todos en un host bloqueado,
 * y la normalización los descartaba todos: cero fuentes, sin un solo error. El
 * sintoma era indistinguible de "no hay resultados".
 *
 * Los fixtures son recortes reales de una página de Bing, no HTML inventado.
 *
 *   node tools/test-extract.mjs
 */
import { ENGINES, normalizeSources, parseHttpResults, resolveUrl } from '../src/engines.js'

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** Un bloque `li.b_algo` tal como lo sirve Bing por HTTP. */
const BING_BLOCK = (host, title, snippet) => `<li class="b_algo" data-id iid=SERP.5325>
<link rel="stylesheet" href="https://r.bing.com/rp/abc.br.css" type="text/css"/>
<h2><a target="_blank" href="https://www.bing.com/ck/a?!&amp;&amp;p=3e5c7e865a48&amp;u=a1aHR0cHM" h="ID=SERP">
<strong>${title}</strong></a></h2>
<div class="b_caption"><div class="b_attribution" u="0|5106|4649"><cite>${host}</cite>
<a target="_blank" href="https://www.bing.com/ck/a?!&amp;&amp;p=fbaf44ab&amp;u=a1"><span class="tptt">${host.replace(/^https?:\/\//, '')}</span></a></div>
<p class="b_lineclamp4 b_algoSlug">${snippet}</p></div></li>`

const BING_HTML = `<html><body><ol id="b_results">
<li class="b_algoPlain"><a href="https://www.bing.com/images">Im&#225;genes</a></li>
${BING_BLOCK('https://www.deepseek.com', 'DeepSeek | Into the Unknown', 'DeepSeek is an AI research company.')}
${BING_BLOCK('https://chat.deepseek.com', 'DeepSeek Chat', 'Chat with DeepSeek AI.')}
${BING_BLOCK('https://deepseek.es', 'DeepSeek en espa&#241;ol', 'Utilice DeepSeek sin registro.')}
</ol></body></html>`

console.log('== 1. Bing: usa <cite>, no los redirectores ==')
const candidates = parseHttpResults(BING_HTML, ENGINES.bing)
check('extrae los 3 bloques b_algo', candidates.length === 3, String(candidates.length))
check('las URLs son destinos reales', candidates.every((entry) => !/bing\.com\/ck\//.test(entry.url)), candidates.map((entry) => entry.url).join(' '))
check('la primera URL es deepseek.com', candidates[0]?.url === 'https://www.deepseek.com', candidates[0]?.url)

console.log('\n== 2. Bing: no confunde navegación con resultados ==')
check('"Imágenes" no aparece', candidates.every((entry) => !/Im/.test(entry.title)), candidates.map((entry) => entry.title).join(' | '))

console.log('\n== 3. Bing: titulos y snippets limpios ==')
check('sin URL incrustada en el titulo', candidates.every((entry) => !/https?:\/\//.test(entry.title)))
check('entidades decodificadas', candidates.some((entry) => entry.title.includes('español')), candidates[2]?.title)
check('snippets presentes', candidates.every((entry) => entry.snippet.length > 10))

console.log('\n== 4. normalizacion: los candidatos sobreviven al filtro de host ==')
const normalised = normalizeSources(candidates.map((entry) => ({ ...entry, url: resolveUrl(entry.url) })), ENGINES.bing, 10)
check('no se descartan por estar en bing.com', normalised.sources.length === 3, `${normalised.sources.length} de 3`)
check('truncated falso cuando caben todos', normalised.truncated === false)

console.log('\n== 5. el limite reporta truncated ==')
const capped = normalizeSources(candidates.map((entry) => ({ ...entry, url: resolveUrl(entry.url) })), ENGINES.bing, 2)
check('corta a 2', capped.sources.length === 2)
check('truncated verdadero', capped.truncated === true)

console.log('\n== 6. otras rutas siguen usando el escaneo generico ==')
const GENERIC = '<html><body><a href="https://example.com/a">Un titulo suficientemente largo</a><a href="https://example.com/b">Corto</a></body></html>'
const generic = parseHttpResults(GENERIC, ENGINES.marginalia)
check('marginalia usa el camino generico', generic.length === 1, `${generic.length}`)
check('descarta el ancla corta', generic[0]?.url === 'https://example.com/a')

const failed = results.filter((entry) => entry.ok === false)
console.log(`\n== RESULTADO: ${results.length - failed.length}/${results.length} ==`)
for (const entry of failed) console.log(`  FAIL ${entry.label}`)
process.exit(failed.length === 0 ? 0 : 1)
