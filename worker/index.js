import { trackHit, handleAnalytics, AnalyticsDO } from './analytics.js'
import { handleDiscover, checkDiscoverFeeds } from './discover.js'
import { handleAuth, memberByToken, isOwnerPubkey } from './auth.js'

export { AnalyticsDO }

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const SEC_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'Content-Security-Policy': 'upgrade-insecure-requests',
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

export default {
  async fetch (req, env, ctx) {
    const url = new URL(req.url)
    const path = url.pathname

    ctx.waitUntil(trackHit(req, env))

    if (path === '/') return withSec(env.ASSETS.fetch(new Request(new URL('/discover/index.html', req.url))))

    if (path === '/api/hit' && req.method === 'POST') {
      ctx.waitUntil(trackHit(req, env))
      return new Response('ok')
    }

    // Discover routes — public except /admin sub-paths (auth handled inside)
    if (path.startsWith('/api/discover')) return handleDiscover(req, env)

    // Auth gate — all /api/* routes not in PUBLIC_API require a valid token
    if (path.startsWith('/api/') && !PUBLIC_API.has(path)) {
      const token = req.headers.get('authorization')?.replace('Bearer ', '')
      const pubkey = token ? await memberByToken(token, env.DISCOVER_KV) : null
      if (!pubkey) return json({ error: 'unauthorized' }, 401)
    }

    // Analytics (owner-only)
    if (path === '/api/analytics') {
      const token = req.headers.get('authorization')?.replace('Bearer ', '')
      const pubkey = token ? await memberByToken(token, env.DISCOVER_KV) : null
      if (!isOwnerPubkey(pubkey, env)) return json({ error: 'unauthorized' }, 401)
      return handleAnalytics(req, env, url.hostname)
    }

    // Auth routes
    if (path === '/api/challenge' || path === '/api/login' || path === '/api/me') {
      return handleAuth(req, env)
    }

    // Sitemap
    if (path === '/sitemap.xml') {
      const { keys } = await env.DISCOVER_KV.list({ prefix: 'feed:' })
      const locs = keys.map(k => `  <url><loc>https://discover.brine.dev/discover/${k.name.slice(5)}</loc></url>`).join('\n')
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://discover.brine.dev/</loc></url>\n  <url><loc>https://discover.brine.dev/about</loc></url>\n${locs}\n</urlset>`
      return new Response(xml, { headers: { 'Content-Type': 'application/xml;charset=utf-8' } })
    }

    // Discover UI
    if (path === '/discover') return Response.redirect(new URL('/', req.url), 301)
    if (path.startsWith('/discover/') && !path.includes('.')) {
      const id = path.slice('/discover/'.length)
      const baseRes = env.ASSETS.fetch(new Request(new URL('/discover/index.html', req.url)))
      if (!id) return withSec(baseRes)
      const feed = await env.DISCOVER_KV.get(`feed:${id}`, 'json').catch(() => null)
      if (!feed) return withSec(baseRes)
      const title = `${feed.title} · discover rss feeds worth reading`
      const desc = feed.description || 'A curated RSS playlist on discover.'
      const img = feed.coverImage?.startsWith('http') ? feed.coverImage : 'https://discover.brine.dev/images/og.png'
      const canonical = `https://discover.brine.dev/discover/${id}`
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

    // My Feed UI
    if (path === '/feed') return withSec(env.ASSETS.fetch(new Request(new URL('/feed/index.html', req.url))))

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
  },

  async scheduled (event, env, ctx) {
    ctx.waitUntil(checkDiscoverFeeds(env).catch(err => console.error('Discover check failed:', err)))
  }
}
