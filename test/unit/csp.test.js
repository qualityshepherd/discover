import { unit as test } from '../testpup.js'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { THEME_INIT_SCRIPT_HASH } from '../../worker/index.js'

// The CSP allows the inline theme-init script by hash instead of an
// external file (it has to run before paint, so it can't wait on a
// network request). If anyone edits the snippet - even a single
// character - without updating THEME_INIT_SCRIPT_HASH, the real CSP
// silently starts blocking it and every page flashes the wrong theme on
// load. This fails loudly instead.
const PAGES = ['assets/404.html', 'assets/about/index.html', 'assets/discover/index.html']

const extractThemeScript = (path) => {
  const html = readFileSync(path, 'utf8')
  const m = html.match(/<script>(document\.documentElement\.dataset\.theme[^<]*)<\/script>/)
  return m ? m[1] : null
}

const hashOf = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`

test('CSP: theme-init script is byte-identical on every page that has it', t => {
  const snippets = PAGES.map(p => extractThemeScript(p))
  for (const [i, s] of snippets.entries()) t.ok(s, `missing theme-init script in ${PAGES[i]}`)
  for (const s of snippets.slice(1)) t.is(s, snippets[0])
})

test('CSP: THEME_INIT_SCRIPT_HASH matches the actual script content', t => {
  const snippet = extractThemeScript('assets/404.html')
  t.is(hashOf(snippet), THEME_INIT_SCRIPT_HASH)
})
