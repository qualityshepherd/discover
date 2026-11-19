// The admin API through the real router, on a real database. Outbound
// fetches are stubbed with fake feeds.
import { unit as test } from '../testpup.js'
import { makeDb, rows } from '../helpers/db.js'
import { handleDiscover } from '../../worker/discover.js'
import { createSession } from '../../worker/db-auth.js'
import { saveFeed, getFeed } from '../../worker/db-feeds.js'
import { saveSourceData } from '../../worker/db-sources.js'
import { savePostTags } from '../../worker/db-search.js'
import { saveCandidates, getCandidates, getPending, savePending } from '../../worker/db-moderation.js'

const OWNER = 'owner-pubkey'

const setup = async () => {
  const db = makeDb()
  const hour = Date.now() + 3600000
  await createSession(db, 'owner-tok', OWNER, hour)
  await createSession(db, 'other-tok', 'someone-else', hour)
  await createSession(db, 'stale-tok', OWNER, Date.now() - 1000)
  const env = { DISCOVER_DB: db, OWNER, DOMAIN_NAME: 'discover.test' }
  const call = async (method, path, body, token = 'owner-tok') => {
    const headers = { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' }
    if (token) headers.authorization = `Bearer ${token}`
    const res = await handleDiscover(new Request(`https://discover.test${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined
    }), env, { waitUntil () {} })
    return { status: res.status, body: await res.json() }
  }
  return { db, call }
}

// rss with n posts of len characters each
const rss = (n = 3, len = 800) => `<?xml version="1.0"?><rss version="2.0"><channel><title>A blog</title><link>https://x.test/</link>${
  Array.from({ length: n }, (_, i) => `<item><title>p${i}</title><link>https://x.test/${i}</link><pubDate>${new Date(Date.now() - (i + 1) * 864e6).toUTCString()}</pubDate><description><![CDATA[<p>${'word '.repeat(len / 5)}</p>]]></description></item>`).join('')
}</channel></rss>`

// swaps global fetch for a map of url -> body; returns the urls it was asked for
const stubFetch = (pages) => {
  const asked = []
  const real = globalThis.fetch
  globalThis.fetch = async (url) => {
    asked.push(String(url))
    const body = pages[String(url)]
    return body ? new Response(body, { status: 200 }) : new Response('nope', { status: 404 })
  }
  return { asked, restore: () => { globalThis.fetch = real } }
}

// the gate

test('admin: no token, a non-owner and an expired session are all turned away', async t => {
  const { call } = await setup()
  t.is((await call('GET', '/api/discover/admin/status', null, null)).status, 401)
  t.is((await call('GET', '/api/discover/admin/status', null, 'other-tok')).status, 401)
  t.is((await call('GET', '/api/discover/admin/status', null, 'stale-tok')).status, 401)
  t.is((await call('GET', '/api/discover/admin/status', null, 'made-up')).status, 401)
})

test('admin: the owner gets in', async t => {
  const { call } = await setup()
  t.is((await call('GET', '/api/discover/admin/status')).status, 200)
})

// curate

const cand = (domain, more = {}) => ({ domain, score: 1, sources: ['a.test'], firstSeen: '2026-11-19', probedAt: new Date().toISOString(), feedUrl: `https://${domain}/feed`, stats: { posts: 4, fullText: true, linksBack: [] }, rejected: null, ...more })

test('curate: only passing candidates show, link-backs first, each with its stats line', async t => {
  const { db, call } = await setup()
  await saveCandidates(db, [
    cand('plain.test'),
    cand('neighbor.test', { stats: { posts: 4, fullText: true, perMonth: 3, authors: 1, linksBack: ['a.test'] } }),
    cand('teaser.test', { rejected: 'truncated' }),
    cand('nofeed.test', { feedUrl: null, stats: null })
  ])
  const { body } = await call('GET', '/api/discover/admin/curate')
  t.deepEqual(body.candidates.map(c => c.domain), ['neighbor.test', 'plain.test'])
  t.is(body.candidates[0].line, '3 posts/mo · 1 author · full text · links back to 1')
})

test('curate: pending rows carry stats and warn about a blog already here', async t => {
  const { db, call } = await setup()
  await saveSourceData(db, 'https://www.old.test/feed', { posts: [] })
  await savePending(db, [
    { url: 'https://old.test/rss.xml', title: 'again', stats: { posts: 3, fullText: true } },
    { url: 'https://new.test/feed', title: 'new' }
  ])
  const { body } = await call('GET', '/api/discover/admin/curate')
  const again = body.pending.find(p => p.title === 'again')
  t.is(again.duplicateOf, 'https://www.old.test/feed')
  t.is(again.line, 'full text')
  t.is(body.pending.find(p => p.title === 'new').duplicateOf, null)
})

test('curate: approving moves a candidate to pending with its stats', async t => {
  const { db, call } = await setup()
  await saveCandidates(db, [cand('good.test', { stats: { posts: 4, fullText: true, linksBack: ['a.test'] } })])
  await call('POST', '/api/discover/admin/curate/approve', { domain: 'good.test', feedUrl: 'https://good.test/feed' })
  t.is((await getCandidates(db)).length, 0)
  const [p] = await getPending(db)
  t.is(p.url, 'https://good.test/feed')
  t.deepEqual(p.stats.linksBack, ['a.test'])
})

test('curate: dismissing removes the candidate and remembers the domain', async t => {
  const { db, call } = await setup()
  await saveCandidates(db, [cand('meh.test')])
  await call('DELETE', '/api/discover/admin/curate/candidate', { domain: 'meh.test' })
  t.is((await getCandidates(db)).length, 0)
  t.deepEqual(rows(db, 'SELECT domain FROM dismissed_domains').map(r => r.domain), ['meh.test'])
})

// adding a source

test('add source: a second feed from a blog already here asks first and fetches nothing', async t => {
  const { db, call } = await setup()
  await saveSourceData(db, 'https://example.test/feed', { posts: [] })
  const f = stubFetch({ 'https://www.example.test/rss.xml': rss() })
  try {
    const { body } = await call('POST', '/api/discover/admin/source', { url: 'https://www.example.test/rss.xml' })
    t.is(body.duplicateOf, 'https://example.test/feed')
    t.is(f.asked.length, 0)
    t.is(rows(db, 'SELECT url FROM sources').length, 1)
  } finally { f.restore() }
})

test('add source: force adds it anyway', async t => {
  const { db, call } = await setup()
  await saveSourceData(db, 'https://example.test/feed', { posts: [] })
  const f = stubFetch({ 'https://www.example.test/rss.xml': rss() })
  try {
    const { body } = await call('POST', '/api/discover/admin/source', { url: 'https://www.example.test/rss.xml', force: true })
    t.ok(body.ok)
    t.is(rows(db, 'SELECT url FROM sources').length, 2)
  } finally { f.restore() }
})

test('add source: the exact same feed is just "existing"', async t => {
  const { db, call } = await setup()
  await saveSourceData(db, 'https://example.test/feed', { posts: [] })
  const { body } = await call('POST', '/api/discover/admin/source', { url: 'https://example.test/feed' })
  t.ok(body.existing)
})

// removing a source from a playlist

test('playlist remove: a source another playlist still uses keeps its posts; the last removal cleans up', async t => {
  const { db, call } = await setup()
  const url = 'https://shared.test/feed'
  await saveSourceData(db, url, { posts: [{ url: 'https://shared.test/1', title: 'one' }] })
  await savePostTags(db, url, [{ url: 'https://shared.test/1', tags: ['x'], date: '2026-11-01' }])
  await saveFeed(db, { id: 'p1', slug: 'p1', title: 'one', sources: [url] })
  await saveFeed(db, { id: 'p2', slug: 'p2', title: 'two', sources: [url] })

  await call('DELETE', '/api/discover/admin/p1/sources', { url })
  t.is(rows(db, 'SELECT url FROM sources').length, 1)
  t.is(rows(db, 'SELECT * FROM post_tags').length, 1)

  await call('DELETE', '/api/discover/admin/p2/sources', { url })
  t.is(rows(db, 'SELECT url FROM sources').length, 0)
  t.is(rows(db, 'SELECT * FROM post_tags').length, 0)
})

// validate

test('validate: excerpts, same blog, and exact duplicates each get their status', async t => {
  const { db, call } = await setup()
  await saveFeed(db, { id: 'p1', slug: 'p1', title: 'one', sources: ['https://here.test/feed'] })
  const f = stubFetch({
    'https://teaser.test/feed': rss(3, 50),
    'https://www.here.test/rss.xml': rss()
  })
  try {
    const { body } = await call('POST', '/api/discover/admin/validate', {
      urls: ['https://teaser.test/feed', 'https://www.here.test/rss.xml', 'https://here.test/feed']
    })
    const by = Object.fromEntries(body.map(r => [r.url, r]))
    t.is(by['https://teaser.test/feed'].status, 'truncated')
    t.is(by['https://www.here.test/rss.xml'].status, 'valid')
    t.is(by['https://www.here.test/rss.xml'].duplicateOf, 'https://here.test/feed')
    t.is(by['https://here.test/feed'].status, 'duplicate')
  } finally { f.restore() }
})

// the public suggest box

test('submit: a good feed lands in pending with its stats', async t => {
  const { db, call } = await setup()
  const f = stubFetch({ 'https://fresh.test/feed': rss() })
  try {
    t.ok((await call('POST', '/api/discover/submit', { url: 'https://fresh.test/feed' }, null)).body.ok)
    const [p] = await getPending(db)
    t.is(p.url, 'https://fresh.test/feed')
    t.ok(p.stats.fullText)
  } finally { f.restore() }
})

test('submit: excerpts and a blog already here are dropped without a word', async t => {
  const { db, call } = await setup()
  await saveSourceData(db, 'https://here.test/feed', { posts: [] })
  const f = stubFetch({ 'https://teaser.test/feed': rss(3, 50), 'https://www.here.test/rss.xml': rss() })
  try {
    t.ok((await call('POST', '/api/discover/submit', { url: 'https://teaser.test/feed' }, null)).body.ok)
    t.ok((await call('POST', '/api/discover/submit', { url: 'https://www.here.test/rss.xml' }, null)).body.ok)
    t.is((await getPending(db)).length, 0)
    t.ok(!f.asked.includes('https://www.here.test/rss.xml'))
  } finally { f.restore() }
})

test('submit: a dismissed domain still gets through - a human typed it in', async t => {
  const { db, call } = await setup()
  db.sqlite.exec("INSERT INTO dismissed_domains (domain) VALUES ('fresh.test')")
  const f = stubFetch({ 'https://fresh.test/feed': rss() })
  try {
    await call('POST', '/api/discover/submit', { url: 'https://fresh.test/feed' }, null)
    t.is((await getPending(db)).length, 1)
  } finally { f.restore() }
})

test('submit: a blocked domain never does', async t => {
  const { db, call } = await setup()
  db.sqlite.exec("INSERT INTO blocked (domain) VALUES ('fresh.test')")
  const f = stubFetch({ 'https://fresh.test/feed': rss() })
  try {
    await call('POST', '/api/discover/submit', { url: 'https://fresh.test/feed' }, null)
    t.is((await getPending(db)).length, 0)
    t.is(f.asked.length, 0)
  } finally { f.restore() }
})

// approving from pending

test('approve: the feed is fetched right away, not left for the cron', async t => {
  const { db, call } = await setup()
  await saveFeed(db, { id: 'p1', slug: 'p1', title: 'one', sources: [] })
  await savePending(db, [{ url: 'https://new.test/feed', title: 'new' }])
  const f = stubFetch({ 'https://new.test/feed': rss() })
  try {
    t.ok((await call('POST', '/api/discover/admin/approve', { url: 'https://new.test/feed', playlistId: 'p1' })).body.ok)
    const feed = await getFeed(db, 'p1')
    t.deepEqual(feed.sources, ['https://new.test/feed'])
    t.is(feed.previewPosts.length, 1)
    t.ok(rows(db, 'SELECT last_fetched FROM sources WHERE url = ?', 'https://new.test/feed')[0].last_fetched)
    t.is((await getPending(db)).length, 0)
  } finally { f.restore() }
})

test('approve: with no playlist it refuses and the feed stays pending', async t => {
  const { db, call } = await setup()
  await savePending(db, [{ url: 'https://new.test/feed', title: 'new' }])
  const res = await call('POST', '/api/discover/admin/approve', { url: 'https://new.test/feed', playlistId: null })
  t.is(res.status, 400)
  t.is((await getPending(db)).length, 1)
})

// trailing slashes

test('a feed curate found as /feed/ is stored, fetched, refreshed and removed under one url', async t => {
  const { db, call } = await setup()
  await saveFeed(db, { id: 'p1', slug: 'p1', title: 'one', sources: [] })
  await saveCandidates(db, [cand('slash.test', { feedUrl: 'https://slash.test/feed/' })])
  const f = stubFetch({ 'https://slash.test/feed': rss() })
  try {
    await call('POST', '/api/discover/admin/curate/approve', { domain: 'slash.test', feedUrl: 'https://slash.test/feed/' })
    t.is((await getPending(db))[0].url, 'https://slash.test/feed')

    await call('POST', '/api/discover/admin/approve', { url: 'https://slash.test/feed', playlistId: 'p1' })
    t.deepEqual((await getFeed(db, 'p1')).sources, ['https://slash.test/feed'])
    t.deepEqual(rows(db, 'SELECT url FROM sources').map(r => r.url), ['https://slash.test/feed'])

    // refresh with the slash, the way the page might send it - same row
    await call('POST', '/api/discover/admin/source/refresh', { url: 'https://slash.test/feed/' })
    t.is(rows(db, 'SELECT url FROM sources').length, 1)

    await call('DELETE', '/api/discover/admin/p1/sources', { url: 'https://slash.test/feed/' })
    t.deepEqual((await getFeed(db, 'p1')).sources, [])
  } finally { f.restore() }
})

test('saveFeed never stores a trailing slash, and two spellings of one feed collapse', async t => {
  const { db } = await setup()
  await saveFeed(db, { id: 'p1', slug: 'p1', title: 'one', sources: ['https://a.test/feed/', 'https://a.test/feed', ' https://b.test/rss// '] })
  t.deepEqual((await getFeed(db, 'p1')).sources.sort(), ['https://a.test/feed', 'https://b.test/rss'])
})
