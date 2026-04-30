// Project-specific analytics for discover.
// To fix bot detection, add RSS aggregators, or tweak the data model — edit analytics-core.js,
// then copy it to brine and rando. Edit here only for discover-specific paths or RSS matchers.

import ANALYTICS_TEMPLATE from './analyticsTemplate.js'
export {
  AnalyticsDO,
  parseRssSubscribers, parseDevice, isBot, isDatacenter,
  countryFlag, countryFlagWithRegion,
  backupKey, historicalDates,
  freshDay, buildHit, serializeDay, deserializeDay, loadDay, resetDay, applyHit, buildR2Backup
} from './analytics-core.js'
import { isBot, isDatacenter, parseRssSubscribers, parseDevice, buildHit, hashIp, getSiteStub, handleAnalytics as _handleAnalytics } from './analytics-core.js'

const SKIP_PATHS = [
  '/.well-known', '/actor', '/api', '/favicon', '/feeds.json', '/feedIndex.json',
  '/index.json', '/manifest.json', '/nodeinfo', '/robots.txt', '/sitemap', '/src'
]

const SKIP_EXTENSIONS = [
  '.bak', '.css', '.ico', '.gz', '.jpg', '.js', '.mp3', '.otf', '.png', '.rar', '.svg', '.tar', '.ttf', '.woff', '.woff2', '.zip'
]

export const classifyHit = (path, ua = '', asn = null) => {
  if (SKIP_PATHS.some(p => path.startsWith(p))) return 'skip'
  const lower = path.toLowerCase().split('?')[0]
  if (SKIP_EXTENSIONS.some(e => lower.endsWith(e))) return 'skip'
  const decoded = (() => { try { return decodeURIComponent(path) } catch { return path } })()
  if (isBot(decoded, ua) || isDatacenter(asn)) return 'bot'
  return 'hit'
}

export async function trackHit (req, env) {
  const url = new URL(req.url)
  const path = url.searchParams.get('path') || (url.pathname + (url.search || ''))
  const ip = req.cf?.clientIp ||
    req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    null
  const ua = req.headers.get('user-agent') || ''
  const asn = req.cf?.asn ?? null

  if (path.length > 500) return
  if (req.headers.get('cookie')?.includes('discover_skip=1')) return
  if (!ip) return

  // Personal feed RSS hit
  const personalRssMatch = path.match(/^\/feed\/([^/]+)\.xml$/)
  if (personalRssMatch) {
    const parsed = parseRssSubscribers(ua)
    const ipHash = await hashIp(ip)
    try {
      const stub = getSiteStub(req, env)
      await stub.fetch('https://do.local/hit', {
        method: 'POST',
        body: JSON.stringify({
          rss: { feed: personalRssMatch[1], subscribers: parsed?.subscribers || 0, aggregator: parsed?.aggregator || null },
          ip: ipHash,
          ts: Date.now()
        })
      })
    } catch (err) { console.error('RSS analytics write failed:', err) }
    return
  }

  // Mentions feed hit
  const mentionsMatch = path.match(/^\/api\/mentions\/([^/]+)\.xml$/)
  if (mentionsMatch) {
    const parsed = parseRssSubscribers(ua)
    const ipHash = await hashIp(ip)
    try {
      const stub = getSiteStub(req, env)
      await stub.fetch('https://do.local/hit', {
        method: 'POST',
        body: JSON.stringify({
          rss: { feed: `mentions:${mentionsMatch[1]}`, subscribers: parsed?.subscribers || 0, aggregator: parsed?.aggregator || null },
          ip: ipHash,
          ts: Date.now()
        })
      })
    } catch (err) { console.error('RSS analytics write failed:', err) }
    return
  }

  // Discover playlist RSS hit
  const discoverRssMatch = path.match(/^\/api\/discover\/([^/]+)\/rss$/)
  if (discoverRssMatch) {
    const id = discoverRssMatch[1]
    const parsed = parseRssSubscribers(ua)
    const ipHash = await hashIp(ip)
    let feedTitle = id
    try {
      const feed = await env.DISCOVER_KV.get(`feed:${id}`, { type: 'json' })
      if (feed?.title) feedTitle = feed.title
    } catch {}
    try {
      const stub = getSiteStub(req, env)
      await stub.fetch('https://do.local/hit', {
        method: 'POST',
        body: JSON.stringify({
          rss: { feed: feedTitle, subscribers: parsed?.subscribers || 0, aggregator: parsed?.aggregator || null },
          ip: ipHash,
          ts: Date.now()
        })
      })
    } catch (err) { console.error('RSS analytics write failed:', err) }
    return
  }

  // RSS feed hit — intercept before classifyHit (which skips .xml extensions)
  if (path.startsWith('/assets/rss/') && path.endsWith('.xml')) {
    const feed = path.split('/').pop()
    const parsed = parseRssSubscribers(ua)
    const ipHash = await hashIp(ip)
    try {
      const stub = getSiteStub(req, env)
      await stub.fetch('https://do.local/hit', {
        method: 'POST',
        body: JSON.stringify({
          rss: { feed, subscribers: parsed?.subscribers || 0, aggregator: parsed?.aggregator || null },
          ip: ipHash,
          ts: Date.now()
        })
      })
    } catch (err) { console.error('RSS analytics write failed:', err) }
    return
  }

  const kind = classifyHit(path, ua, asn)
  if (kind === 'skip') return

  const ipHash = await hashIp(ip)

  if (kind === 'bot') {
    const cache = caches.default
    const cacheKey = new Request('https://bot-throttle.local/' + ipHash)
    if (await cache.match(cacheKey)) return
    await cache.put(cacheKey, new Response('1', { headers: { 'Cache-Control': 'max-age=600' } }))
    const cf = req.cf || {}
    const stub = getSiteStub(req, env)
    await stub.fetch('https://do.local/hit', {
      method: 'POST',
      body: JSON.stringify({ bot: true, path, ip: ipHash, country: cf.country || '?', city: cf.city || '?', asn, ts: Date.now() })
    })
    return
  }

  const cf = req.cf || {}
  const referer = req.headers.get('referer') || ''
  let referrer = ''
  try {
    if (referer && new URL(referer).hostname !== new URL(req.url).hostname) referrer = referer
  } catch {}
  const device = parseDevice(ua)
  const hit = buildHit(path, cf, ipHash, referrer, Date.now(), device)
  try {
    const stub = getSiteStub(req, env)
    await stub.fetch('https://do.local/hit', { method: 'POST', body: JSON.stringify(hit) })
  } catch (err) { console.error('Analytics write failed:', err) }
}

export const handleAnalytics = (req, env, hostname) => _handleAnalytics(req, env, hostname, ANALYTICS_TEMPLATE)
