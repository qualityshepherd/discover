import { trackHit } from './hit.js'
import { handleDiscover, handleMentionsFeed, checkDiscoverFeeds } from './discover.js'
import { handleAuth, memberByToken } from './auth.js'
import { getFeed } from './db-feeds.js'
import { json } from './utils.js'
import { isEdgeCacheable, withEdgeCache } from './cache.js'

const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Hash of the inline theme-init <script> - identical in discover/index.html,
// about/index.html and 404.html (test/unit/csp.test.js fails if any of them
// drift from this without the hash getting updated too). It runs before
// paint to avoid a flash of the wrong theme, which is why it's inline
// instead of an external file like everything else.
export const THEME_INIT_SCRIPT_HASH = "'sha256-bvBIUAeQ2tzEYRLy8ZwPtRT/ss5nYHCavo4Wt0GU1do='"

// Report-only for now - logs violations to the browser console without
// blocking anything. Once that's been watched for a few days with nothing
// unexpected showing up, this becomes the real Content-Security-Policy.
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  `script-src 'self' ${THEME_INIT_SCRIPT_HASH}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data:",
  'frame-src https:',
  "connect-src 'self'",
  'media-src https:',
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ')

const SEC_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'Content-Security-Policy': 'upgrade-insecure-requests',
  'Content-Security-Policy-Report-Only': CSP_REPORT_ONLY,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin'
}

const htmlRes = (body, extra = {}) =>
  new Response(body, { headers: { 'Content-Type': 'text/html;charset=utf-8', ...SEC_HEADERS, ...extra } })

const withSec = async (res) => {
  const r = await res
  const h = new Headers(r.headers)
  for (const [k, v] of Object.entries(SEC_HEADERS)) h.set(k, v)
  return new Response(r.body, { status: r.status, headers: h })
}

const PUBLIC_API = new Set(['/api/challenge', '/api/login', '/api/me', '/api/hit'])

const PRIVATE = [
  '/worker/', '/test/', '/node_modules/',
  '/wrangler.toml', '/package.json', '/package-lock.json',
  '/README.md', '/LICENSE'
]

// paths the server just hands the SPA shell to, no extra work. every route
// discover.js's route() handles needs to be listed here too, or a refresh
// 404s even though clicking there from inside the app works fine. bit us
// twice already (/tag/*, /filters). /discover/:id isn't here - it needs its
// own block below for the SEO meta + slug redirect stuff, which needs D1
export const isSpaRoute = (path) =>
  path === '/' || path === '/new' || path === '/random' || path === '/filters' || path.startsWith('/tag/')

export default {
  async fetch (req, env, ctx) {
    const response = await handleRequest(req, env, ctx)
    ctx.waitUntil(trackHit(req, env, response.status))
    return response
  },

  async scheduled (event, env, ctx) {
    ctx.waitUntil(checkDiscoverFeeds(env).catch(err => console.error('Discover check failed:', err)))
  }
}

async function handleRequest (req, env, ctx) {
  if (isEdgeCacheable(req)) return withEdgeCache(req, ctx, () => route(req, env, ctx))
  return route(req, env, ctx)
}

async function route (req, env, ctx) {
  const url = new URL(req.url)
  const path = url.pathname

  if (isSpaRoute(path)) return withSec(env.ASSETS.fetch(new Request(new URL('/discover/index.html', req.url))))

  if (path === '/api/hit' && req.method === 'POST') {
    return new Response('ok')
  }

  // Mentions feeds — public RSS per source
  const mentionsMatch = path.match(/^\/api\/mentions\/([^/]+)\.xml$/)
  if (mentionsMatch) return handleMentionsFeed(env.DISCOVER_DB, mentionsMatch[1], req.url)

  // Discover routes — public except /admin sub-paths (auth handled inside)
  if (path.startsWith('/api/discover')) return handleDiscover(req, env, ctx)

  // Auth gate — all /api/* routes not in PUBLIC_API require a valid token
  if (path.startsWith('/api/') && !PUBLIC_API.has(path)) {
    const token = req.headers.get('authorization')?.replace('Bearer ', '')
    const pubkey = token ? await memberByToken(token, env.DISCOVER_DB) : null
    if (!pubkey) return json({ error: 'unauthorized' }, 401)
  }

  // Auth routes
  if (path === '/api/challenge' || path === '/api/login' || path === '/api/me') {
    return handleAuth(req, env)
  }

  // Sitemap
  if (path === '/sitemap.xml') {
    const rows = await env.DISCOVER_DB.prepare('SELECT id, slug FROM feeds').all()
    const base = `https://${env.DOMAIN_NAME}`
    const locs = rows.results.map(r => `  <url><loc>${base}/discover/${r.slug || r.id}</loc></url>`).join('\n')
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${base}/</loc></url>\n  <url><loc>${base}/about</loc></url>\n${locs}\n</urlset>`
    return new Response(xml, { headers: { 'Content-Type': 'application/xml;charset=utf-8' } })
  }

  // Discover UI
  if (path === '/discover') return Response.redirect(new URL('/', req.url), 301)
  if (path.startsWith('/discover/') && !path.includes('.')) {
    const id = path.slice('/discover/'.length)
    const baseRes = env.ASSETS.fetch(new Request(new URL('/discover/index.html', req.url)))
    if (!id) return withSec(baseRes)
    const feed = await getFeed(env.DISCOVER_DB, id).catch(() => null)
    if (!feed) return withSec(baseRes)
    // hex links still resolve forever, but once a slug exists that's the
    // real url - bounce people there
    if (feed.slug && feed.slug !== id) return Response.redirect(new URL(`/discover/${feed.slug}`, req.url), 301)
    const title = `${feed.title} · discover rss feeds worth reading`
    const desc = feed.description || 'A curated RSS playlist on discover.'
    const img = feed.coverImage?.startsWith('http') ? feed.coverImage : `https://${env.DOMAIN_NAME}/images/og.png`
    const canonical = `https://${env.DOMAIN_NAME}/discover/${id}`
    const inject = [
        `  <meta name="description" content="${escHtml(desc)}">`,
        '  <meta property="og:type" content="website">',
        '  <meta property="og:site_name" content="discover">',
        `  <meta property="og:title" content="${escHtml(title)}">`,
        `  <meta property="og:description" content="${escHtml(desc)}">`,
        `  <meta property="og:url" content="${escHtml(canonical)}">`,
        `  <meta property="og:image" content="${escHtml(img)}">`,
        '  <meta name="twitter:card" content="summary_large_image">',
        `  <meta name="twitter:title" content="${escHtml(title)}">`,
        `  <meta name="twitter:description" content="${escHtml(desc)}">`,
        `  <meta name="twitter:image" content="${escHtml(img)}">`,
        `  <link rel="canonical" href="${escHtml(canonical)}">`
    ].join('\n')
    const html = await (await baseRes).text()
    return htmlRes(html.replace('<title>', inject + '\n  <title>'))
  }

  // About UI
  if (path === '/about') return withSec(env.ASSETS.fetch(new Request(new URL('/about/index.html', req.url))))

  // Admin UI
  if (path === '/admin' || (path.startsWith('/admin/') && !path.includes('.'))) {
    return withSec(env.ASSETS.fetch(new Request(new URL('/admin/index.html', req.url))))
  }

  // Block private paths
  if (PRIVATE.some(p => path === p || path.startsWith(p))) {
    return new Response('Not found', { status: 404 })
  }

  // Unknown page routes → 404
  if (!path.includes('.')) {
    const body = await env.ASSETS.fetch(new Request(new URL('/404.html', req.url))).then(r => r.text()).catch(() => 'Not found')
    return htmlRes(body, { status: 404 })
  }

  return env.ASSETS.fetch(req)
}
