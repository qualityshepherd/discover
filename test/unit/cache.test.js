import { unit as test } from '../testpup.js'
import { isEdgeCacheable, withEdgeCache, EDGE_CACHE_CONTROL } from '../../worker/cache.js'

const get = (path, init) => new Request(`https://discover.brine.dev${path}`, init)

test('isEdgeCacheable: public RSS and discover read routes', t => {
  for (const p of [
    '/api/discover/new',
    '/api/discover/tag/rss',
    '/api/discover/search?q=cats',
    '/api/discover/abc123/rss',
    '/api/mentions/example.com.xml',
    '/feed/brine.xml'
  ]) t.ok(isEdgeCacheable(get(p)), p)
})

test('isEdgeCacheable: never caches random, admin, writes, or authed requests', t => {
  for (const p of ['/api/discover/random', '/api/discover/admin/status', '/api/feed/brine', '/api/discover']) {
    t.falsy(isEdgeCacheable(get(p)), p)
  }
  t.falsy(isEdgeCacheable(get('/api/discover/new', { method: 'POST' })))
  t.falsy(isEdgeCacheable(get('/api/discover/new', { headers: { authorization: 'Bearer x' } })))
})

const withFakeCache = async (fn) => {
  const store = new Map()
  const original = globalThis.caches
  globalThis.caches = {
    default: {
      match: async (req) => store.get(req.url)?.clone(),
      put: async (req, res) => { store.set(req.url, res) }
    }
  }
  try { await fn(store) } finally { globalThis.caches = original }
}

const ctx = () => {
  const pending = []
  return { waitUntil: p => pending.push(p), flush: () => Promise.all(pending) }
}

test('withEdgeCache: miss builds and stores, hit skips the handler', async t => {
  await withFakeCache(async () => {
    let builds = 0
    const build = async () => { builds++; return new Response('<rss/>', { headers: { 'Cache-Control': 'no-store' } }) }
    const c = ctx()

    const first = await withEdgeCache(get('/feed/a.xml'), c, build)
    await c.flush()
    t.is(first.headers.get('X-Edge-Cache'), 'MISS')
    t.is(first.headers.get('Cache-Control'), EDGE_CACHE_CONTROL)
    t.is(await first.text(), '<rss/>')

    const second = await withEdgeCache(get('/feed/a.xml'), c, build)
    t.is(second.headers.get('X-Edge-Cache'), 'HIT')
    t.is(await second.text(), '<rss/>')
    t.is(builds, 1)
  })
})

test('withEdgeCache: query string is part of the key', async t => {
  await withFakeCache(async () => {
    let builds = 0
    const build = async () => { builds++; return new Response('x') }
    const c = ctx()
    await withEdgeCache(get('/api/discover/search?q=a'), c, build)
    await c.flush()
    await withEdgeCache(get('/api/discover/search?q=b'), c, build)
    t.is(builds, 2)
  })
})

test('withEdgeCache: non-200 responses are not cached', async t => {
  await withFakeCache(async (store) => {
    const c = ctx()
    const res = await withEdgeCache(get('/feed/missing.xml'), c, async () => new Response('nope', { status: 404 }))
    await c.flush()
    t.is(res.status, 404)
    t.is(store.size, 0)
  })
})

test('withEdgeCache: falls through to the handler when the Cache API is unavailable', async t => {
  const original = globalThis.caches
  globalThis.caches = undefined
  try {
    const res = await withEdgeCache(get('/feed/a.xml'), ctx(), async () => new Response('ok'))
    t.is(await res.text(), 'ok')
  } finally { globalThis.caches = original }
})
