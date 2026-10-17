// Edge cache for public, non-personalized GET routes (RSS feeds + discover API).
//
// Uses the Workers Cache API directly instead of relying on a bare Cache-Control
// header, because whether Cloudflare caches a Worker response at the edge otherwise
// depends on zone Cache Rules. Note: caches.default only works on a custom domain
// (not *.workers.dev), which discover.brine.dev is.

export const EDGE_CACHE_CONTROL = 'public, max-age=300, s-maxage=1800'

const CACHEABLE = [
  /^\/api\/discover\/new$/,
  /^\/api\/discover\/tag\/[^/]+$/,
  /^\/api\/discover\/search$/,
  /^\/api\/discover\/[^/]+\/rss$/,
  /^\/api\/mentions\/[^/]+\.xml$/,
  /^\/feed\/[^/]+\.xml$/
]

export const isEdgeCacheable = (req) => {
  if (req.method !== 'GET') return false
  if (req.headers.get('authorization')) return false
  const { pathname } = new URL(req.url)
  return CACHEABLE.some(re => re.test(pathname))
}

const tag = (res, state) => {
  const out = new Response(res.body, res)
  out.headers.set('X-Edge-Cache', state)
  return out
}

export const withEdgeCache = async (req, ctx, build) => {
  const cache = globalThis.caches?.default
  if (!cache) return build()

  // Key on the URL alone so request headers can't fragment the cache
  const key = new Request(req.url, { method: 'GET' })

  const hit = await cache.match(key).catch(() => null)
  if (hit) return tag(hit, 'HIT')

  const res = await build()
  if (res.status !== 200) return res

  const out = tag(res, 'MISS')
  out.headers.set('Cache-Control', EDGE_CACHE_CONTROL)
  ctx.waitUntil(cache.put(key, out.clone()).catch(() => {}))
  return out
}
