import { unit as test } from '../testpup.js'
import { shouldSkip, identifyRssFeed, trackHit } from '../../worker/hit.js'

// shouldSkip — scope filtering only. Bot/device/RSS classification now
// happens in chalk, not here.
test('shouldSkip: skips static extensions', t => { t.ok(shouldSkip('/assets/css/style.css')) })
test('shouldSkip: skips png', t => { t.ok(shouldSkip('/apple-touch-icon.png')) })
test('shouldSkip: skips mp3', t => { t.ok(shouldSkip('/pods/episode.mp3')) })
test('shouldSkip: skips js by extension', t => { t.ok(shouldSkip('/src/app.js')) })
test('shouldSkip: skips /api paths', t => { t.ok(shouldSkip('/api/discover/admin/status')) })
test('shouldSkip: skips /favicon paths', t => { t.ok(shouldSkip('/favicon.png')) })
test('shouldSkip: skips /sitemap paths', t => { t.ok(shouldSkip('/sitemap.xml')) })
test('shouldSkip: normal path is not skipped', t => { t.falsy(shouldSkip('/')) })
test('shouldSkip: extension check ignores query string', t => { t.ok(shouldSkip('/style.css?v=2')) })

// identifyRssFeed — discover has four distinct feed routes, only this app
// knows the mapping from path to feed identifier.
test('identifyRssFeed: personal feed', async t => {
  const feed = await identifyRssFeed('/feed/brine.xml', {})
  t.is(feed, 'brine')
})

test('identifyRssFeed: mentions feed is prefixed', async t => {
  const feed = await identifyRssFeed('/api/mentions/hackernews.xml', {})
  t.is(feed, 'mentions:hackernews')
})

test('identifyRssFeed: generic assets/rss feed uses filename', async t => {
  const feed = await identifyRssFeed('/assets/rss/weekly.xml', {})
  t.is(feed, 'weekly.xml')
})

test('identifyRssFeed: non-feed path returns null', async t => {
  const feed = await identifyRssFeed('/posts/hello', {})
  t.is(feed, null)
})

test('identifyRssFeed: discover playlist feed looks up title from D1', async t => {
  const mockDb = {
    prepare (query) {
      return {
        bind () {
          return {
            first: async () => (query.includes('feeds') ? { id: 'abc123', title: 'Cool Playlist' } : null),
            all: async () => ({ results: [] })
          }
        }
      }
    }
  }
  const feed = await identifyRssFeed('/api/discover/abc123/rss', { DISCOVER_DB: mockDb })
  t.is(feed, 'Cool Playlist')
})

test('identifyRssFeed: discover playlist feed falls back to id when lookup fails', async t => {
  const mockDb = {
    prepare () {
      return { bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }) }
    }
  }
  const feed = await identifyRssFeed('/api/discover/missing/rss', { DISCOVER_DB: mockDb })
  t.is(feed, 'missing')
})

async function withMockFetch (impl, fn) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = impl
  try {
    await fn()
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('trackHit: forwards raw signal to chalk', async t => {
  let captured = null
  await withMockFetch(async (url, init) => {
    captured = { url, init }
    return new Response('ok')
  }, async () => {
    const req = new Request('https://discover.brine.dev/', {
      headers: { 'cf-connecting-ip': '1.2.3.4', 'user-agent': 'Mozilla/5.0' }
    })
    await trackHit(req, { CHALK_HIT_SECRET: 'secret', DOMAIN_NAME: 'discover.brine.dev' })
  })

  t.ok(captured !== null)
  t.is(captured.url, 'https://chalk.brine.dev/hit')
  t.is(captured.init.headers['x-hit-secret'], 'secret')

  const body = JSON.parse(captured.init.body)
  t.is(body.domain, 'discover.brine.dev')
  t.is(body.path, '/')
  t.is(body.ip, '1.2.3.4')
  t.is(body.ua, 'Mozilla/5.0')
  t.is(body.rss_feed, null)
})

test('trackHit: forwards personal RSS feed hit even though it is under a skip-worthy shape', async t => {
  let captured = null
  await withMockFetch(async (url, init) => { captured = init; return new Response('ok') }, async () => {
    const req = new Request('https://discover.brine.dev/feed/brine.xml', {
      headers: { 'cf-connecting-ip': '1.2.3.4' }
    })
    await trackHit(req, { CHALK_HIT_SECRET: 'secret', DOMAIN_NAME: 'discover.brine.dev' })
  })

  t.ok(captured !== null)
  const body = JSON.parse(captured.body)
  t.is(body.rss_feed, 'brine')
})

test('trackHit: mentions feed under /api is not skipped', async t => {
  let captured = null
  await withMockFetch(async (url, init) => { captured = init; return new Response('ok') }, async () => {
    const req = new Request('https://discover.brine.dev/api/mentions/hackernews.xml', {
      headers: { 'cf-connecting-ip': '1.2.3.4' }
    })
    await trackHit(req, { CHALK_HIT_SECRET: 'secret', DOMAIN_NAME: 'discover.brine.dev' })
  })

  t.ok(captured !== null)
  const body = JSON.parse(captured.body)
  t.is(body.rss_feed, 'mentions:hackernews')
})

test('trackHit: does not forward other /api requests', async t => {
  let called = false
  await withMockFetch(async () => { called = true; return new Response('ok') }, async () => {
    const req = new Request('https://discover.brine.dev/api/discover/admin/status', {
      headers: { 'cf-connecting-ip': '1.2.3.4' }
    })
    await trackHit(req, { CHALK_HIT_SECRET: 'secret', DOMAIN_NAME: 'discover.brine.dev' })
  })

  t.falsy(called)
})

test('trackHit: does not forward asset requests', async t => {
  let called = false
  await withMockFetch(async () => { called = true; return new Response('ok') }, async () => {
    const req = new Request('https://discover.brine.dev/assets/css/style.css', {
      headers: { 'cf-connecting-ip': '1.2.3.4' }
    })
    await trackHit(req, { CHALK_HIT_SECRET: 'secret', DOMAIN_NAME: 'discover.brine.dev' })
  })

  t.falsy(called)
})

test('trackHit: does nothing without CHALK_HIT_SECRET configured', async t => {
  let called = false
  await withMockFetch(async () => { called = true; return new Response('ok') }, async () => {
    const req = new Request('https://discover.brine.dev/', { headers: { 'cf-connecting-ip': '1.2.3.4' } })
    await trackHit(req, {})
  })

  t.falsy(called)
})

test('trackHit: does nothing without a resolvable IP', async t => {
  let called = false
  await withMockFetch(async () => { called = true; return new Response('ok') }, async () => {
    const req = new Request('https://discover.brine.dev/')
    await trackHit(req, { CHALK_HIT_SECRET: 'secret', DOMAIN_NAME: 'discover.brine.dev' })
  })

  t.falsy(called)
})

test('trackHit: respects discover_skip cookie', async t => {
  let called = false
  await withMockFetch(async () => { called = true; return new Response('ok') }, async () => {
    const req = new Request('https://discover.brine.dev/', {
      headers: { 'cf-connecting-ip': '1.2.3.4', cookie: 'discover_skip=1' }
    })
    await trackHit(req, { CHALK_HIT_SECRET: 'secret', DOMAIN_NAME: 'discover.brine.dev' })
  })

  t.falsy(called)
})
