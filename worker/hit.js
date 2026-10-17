// Discover forwards raw hit signal to chalk (chalk.brine.dev) — bot/device/
// RSS-subscriber classification all happen there now, not here. This file
// only decides scope (is this even a candidate event worth a network call)
// and identifies which of discover's several RSS feed routes a hit belongs
// to — routing knowledge only this app has.
import { getFeed } from './db-feeds.js'

// Playlist titles only label analytics events, so a stale title is harmless.
// Memoize per isolate so frequent RSS polling doesn't query D1 on every hit.
const TITLE_TTL_MS = 60 * 60 * 1000
const TITLE_CACHE_MAX = 500
const titleCache = new Map()

export const clearTitleCache = () => titleCache.clear()

const playlistLabel = async (env, id) => {
  const cached = titleCache.get(id)
  if (cached && cached.expires > Date.now()) return cached.label
  const feed = await getFeed(env.DISCOVER_DB, id).catch(() => null)
  const label = feed?.title || id
  if (titleCache.size >= TITLE_CACHE_MAX) titleCache.clear()
  titleCache.set(id, { label, expires: Date.now() + TITLE_TTL_MS })
  return label
}

const SKIP_PATHS = ['/api']

const SKIP_EXTENSIONS = [
  '.bak', '.css', '.ico', '.gz', '.jpg', '.js', '.mp3', '.otf', '.png', '.rar', '.svg', '.tar', '.ttf', '.woff', '.woff2', '.zip'
]

export const shouldSkip = (path) => {
  if (SKIP_PATHS.some(p => path.startsWith(p))) return true
  const lower = path.toLowerCase().split('?')[0]
  return SKIP_EXTENSIONS.some(e => lower.endsWith(e))
}

// Returns a feed identifier string if the path is one of discover's RSS
// routes, else null. Checked ahead of shouldSkip since several of these
// live under /api, which is otherwise skipped.
export async function identifyRssFeed (path, env) {
  const personal = path.match(/^\/feed\/([^/]+)\.xml$/)
  if (personal) return personal[1]

  const mentions = path.match(/^\/api\/mentions\/([^/]+)\.xml$/)
  if (mentions) return `mentions:${mentions[1]}`

  const playlist = path.match(/^\/api\/discover\/([^/]+)\/rss$/)
  if (playlist) return playlistLabel(env, playlist[1])

  if (path.startsWith('/assets/rss/') && path.endsWith('.xml')) {
    return path.split('/').pop()
  }

  return null
}

export async function trackHit (req, env, status) {
  if (!env.CHALK_HIT_SECRET) return

  const url = new URL(req.url)
  const path = url.searchParams.get('path') || (url.pathname + (url.search || ''))
  if (path.length > 500) return
  if (req.headers.get('cookie')?.includes('discover_skip=1')) return

  const ip = req.cf?.clientIp ||
    req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    null
  if (!ip) return

  const rssFeed = await identifyRssFeed(path, env)
  if (!rssFeed && shouldSkip(path)) return

  const ua = req.headers.get('user-agent') || ''
  const cf = req.cf || {}

  const referer = req.headers.get('referer') || ''
  let referrer = ''
  try {
    if (referer && new URL(referer).hostname !== new URL(req.url).hostname) referrer = referer
  } catch {}

  await fetch('https://chalk.brine.dev/hit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hit-secret': env.CHALK_HIT_SECRET },
    body: JSON.stringify({
      domain: env.DOMAIN_NAME,
      path,
      referrer,
      ua,
      ip,
      country: cf.country,
      city: cf.city,
      region: cf.region,
      asn: cf.asn,
      as_organization: cf.asOrganization,
      http_protocol: cf.httpProtocol,
      rss_feed: rssFeed,
      status,
      ts: Date.now()
    })
  }).catch(() => {})
}
