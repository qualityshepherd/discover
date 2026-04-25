import { unit as test } from '../testpup.js'
import {
  getFeed, saveFeed, saveFeeds, getFeeds, getIndex,
  addToIndex, removeFromIndex,
  getPending, getBlocked,
  getSourceData, saveSourceData,
  KV_FEEDS_LIST, KV_PENDING, KV_BLOCKED
} from '../../worker/discover-kv.js'
import { safeUrl } from '../../worker/feedParser.js'

const makeKv = (initial = {}) => {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]))
  return {
    get: async (key, opts) => {
      const val = store.get(key)
      if (val == null) return null
      return opts?.type === 'json' ? JSON.parse(val) : val
    },
    put: async (key, val) => store.set(key, typeof val === 'string' ? val : JSON.stringify(val)),
    delete: async (key) => store.delete(key),
    _store: () => store
  }
}

// ── getFeed / saveFeed ────────────────────────────────────────────────────────

test('getFeed: returns null when not found', async t => {
  t.is(await getFeed(makeKv(), 'missing'), null)
})

test('saveFeed + getFeed: round-trips a feed object', async t => {
  const kv = makeKv()
  const feed = { id: 'abc123', title: 'Test Feed', sources: ['https://example.com/feed.xml'] }
  await saveFeed(kv, feed)
  const result = await getFeed(kv, 'abc123')
  t.is(result.title, 'Test Feed')
  t.deepEqual(result.sources, ['https://example.com/feed.xml'])
})

test('saveFeed: overwrites existing entry', async t => {
  const kv = makeKv()
  await saveFeed(kv, { id: 'x', title: 'Old' })
  await saveFeed(kv, { id: 'x', title: 'New' })
  const result = await getFeed(kv, 'x')
  t.is(result.title, 'New')
})

// ── getIndex / addToIndex / removeFromIndex ───────────────────────────────────

test('getIndex: returns empty array when no index', async t => {
  t.deepEqual(await getIndex(makeKv()), [])
})

test('addToIndex: adds id to index', async t => {
  const kv = makeKv()
  await addToIndex(kv, 'id1')
  t.deepEqual(await getIndex(kv), ['id1'])
})

test('addToIndex: deduplicates', async t => {
  const kv = makeKv()
  await addToIndex(kv, 'id1')
  await addToIndex(kv, 'id1')
  t.deepEqual(await getIndex(kv), ['id1'])
})

test('addToIndex: appends multiple ids', async t => {
  const kv = makeKv()
  await addToIndex(kv, 'id1')
  await addToIndex(kv, 'id2')
  const index = await getIndex(kv)
  t.is(index.length, 2)
  t.ok(index.includes('id1'))
  t.ok(index.includes('id2'))
})

test('removeFromIndex: removes existing id', async t => {
  const kv = makeKv()
  await addToIndex(kv, 'id1')
  await addToIndex(kv, 'id2')
  await removeFromIndex(kv, 'id1')
  const index = await getIndex(kv)
  t.deepEqual(index, ['id2'])
})

test('removeFromIndex: no-ops on missing id', async t => {
  const kv = makeKv()
  await addToIndex(kv, 'id1')
  await removeFromIndex(kv, 'nope')
  t.deepEqual(await getIndex(kv), ['id1'])
})

test('removeFromIndex: immutable — does not mutate existing index', async t => {
  const kv = makeKv()
  await addToIndex(kv, 'id1')
  await addToIndex(kv, 'id2')
  await addToIndex(kv, 'id3')
  await removeFromIndex(kv, 'id2')
  t.deepEqual(await getIndex(kv), ['id1', 'id3'])
})

// ── getFeeds ──────────────────────────────────────────────────────────────────

test('getFeeds: returns empty array when index is empty', async t => {
  t.deepEqual(await getFeeds(makeKv()), [])
})

test('getFeeds: returns all feeds in index order', async t => {
  const kv = makeKv()
  await saveFeed(kv, { id: 'a', title: 'Alpha' })
  await saveFeed(kv, { id: 'b', title: 'Beta' })
  await addToIndex(kv, 'a')
  await addToIndex(kv, 'b')
  const feeds = await getFeeds(kv)
  t.is(feeds.length, 2)
  t.is(feeds[0].id, 'a')
  t.is(feeds[1].id, 'b')
})

test('getFeeds: skips ids that have no matching feed entry', async t => {
  const kv = makeKv()
  await saveFeed(kv, { id: 'a', title: 'Alpha' })
  await addToIndex(kv, 'a')
  await addToIndex(kv, 'orphan')
  const feeds = await getFeeds(kv)
  t.is(feeds.length, 1)
  t.is(feeds[0].id, 'a')
})

// ── feeds-list cache (KV_FEEDS_LIST) ─────────────────────────────────────────

test('getFeeds: seeds KV_FEEDS_LIST on first fallback read', async t => {
  const kv = makeKv()
  // populate individual keys + index without using saveFeed
  const feed = { id: 'a', title: 'Alpha' }
  await kv.put('discover:feed:a', JSON.stringify(feed))
  await kv.put('discover:index', JSON.stringify(['a']))
  // no KV_FEEDS_LIST yet — triggers fallback + seed
  const feeds = await getFeeds(kv)
  t.is(feeds.length, 1)
  // cache should now be seeded
  const cached = await kv.get(KV_FEEDS_LIST, { type: 'json' })
  t.is(cached.length, 1)
  t.is(cached[0].id, 'a')
})

test('getFeeds: returns from cache when KV_FEEDS_LIST exists', async t => {
  const kv = makeKv({ [KV_FEEDS_LIST]: [{ id: 'cached', title: 'From Cache' }] })
  const feeds = await getFeeds(kv)
  t.is(feeds.length, 1)
  t.is(feeds[0].id, 'cached')
})

test('saveFeed: updates KV_FEEDS_LIST on insert', async t => {
  const kv = makeKv()
  await saveFeed(kv, { id: 'x', title: 'New' })
  const cached = await kv.get(KV_FEEDS_LIST, { type: 'json' })
  t.is(cached.length, 1)
  t.is(cached[0].id, 'x')
})

test('saveFeed: updates existing entry in KV_FEEDS_LIST', async t => {
  const kv = makeKv()
  await saveFeed(kv, { id: 'x', title: 'Old' })
  await saveFeed(kv, { id: 'x', title: 'New' })
  const cached = await kv.get(KV_FEEDS_LIST, { type: 'json' })
  t.is(cached.length, 1)
  t.is(cached[0].title, 'New')
})

test('removeFromIndex: removes entry from KV_FEEDS_LIST', async t => {
  const kv = makeKv()
  await saveFeed(kv, { id: 'a', title: 'Alpha' })
  await saveFeed(kv, { id: 'b', title: 'Beta' })
  await addToIndex(kv, 'a')
  await addToIndex(kv, 'b')
  await removeFromIndex(kv, 'a')
  const cached = await kv.get(KV_FEEDS_LIST, { type: 'json' })
  t.is(cached.length, 1)
  t.is(cached[0].id, 'b')
})

test('saveFeeds: writes individual keys and KV_FEEDS_LIST in one round', async t => {
  const kv = makeKv()
  const allFeeds = [
    { id: 'a', title: 'Alpha', previewPosts: [] },
    { id: 'b', title: 'Beta', previewPosts: [] }
  ]
  await saveFeeds(kv, allFeeds, allFeeds)
  const cached = await kv.get(KV_FEEDS_LIST, { type: 'json' })
  t.is(cached.length, 2)
  const a = await kv.get('discover:feed:a', { type: 'json' })
  t.is(a.title, 'Alpha')
  const b = await kv.get('discover:feed:b', { type: 'json' })
  t.is(b.title, 'Beta')
})

test('saveFeeds: only writes specified feeds as individual keys', async t => {
  const kv = makeKv()
  const allFeeds = [{ id: 'a', title: 'Alpha' }, { id: 'b', title: 'Beta' }]
  await saveFeeds(kv, allFeeds, [allFeeds[0]])
  t.ok(await kv.get('discover:feed:a', { type: 'json' }))
  t.is(await kv.get('discover:feed:b'), null)
  const cached = await kv.get(KV_FEEDS_LIST, { type: 'json' })
  t.is(cached.length, 2)
})

// ── getPending / getBlocked ───────────────────────────────────────────────────

test('getPending: returns empty when not set', async t => {
  const result = await getPending(makeKv())
  t.deepEqual(result || [], [])
})

test('getPending: returns stored pending list', async t => {
  const kv = makeKv({ [KV_PENDING]: [{ url: 'https://example.com/feed.xml', title: 'Ex' }] })
  const pending = await getPending(kv)
  t.is(pending.length, 1)
  t.is(pending[0].url, 'https://example.com/feed.xml')
})

test('getBlocked: returns empty when not set', async t => {
  const result = await getBlocked(makeKv())
  t.deepEqual(result || [], [])
})

test('getBlocked: returns stored blocked list', async t => {
  const kv = makeKv({ [KV_BLOCKED]: ['badsite.com', 'spam.net'] })
  const blocked = await getBlocked(kv)
  t.deepEqual(blocked, ['badsite.com', 'spam.net'])
})

// ── getSourceData / saveSourceData ────────────────────────────────────────────

test('getSourceData: returns null when not found', async t => {
  t.is(await getSourceData(makeKv(), 'https://example.com/feed.xml'), null)
})

test('saveSourceData + getSourceData: round-trips source data', async t => {
  const kv = makeKv()
  const url = 'https://example.com/feed.xml'
  const data = { posts: [{ title: 'Post 1', url: 'https://example.com/1' }], lastFetched: '2024-01-01' }
  await saveSourceData(kv, url, data)
  const result = await getSourceData(kv, url)
  t.is(result.lastFetched, '2024-01-01')
  t.is(result.posts.length, 1)
})

test('saveSourceData: same url always maps to same key', async t => {
  const kv = makeKv()
  const url = 'https://example.com/feed.xml'
  await saveSourceData(kv, url, { version: 1 })
  await saveSourceData(kv, url, { version: 2 })
  const result = await getSourceData(kv, url)
  t.is(result.version, 2)
})

// ── approve logic: pending.filter is immutable ────────────────────────────────

test('pending filter: removing by index does not mutate original array', async t => {
  const pending = [
    { url: 'https://a.com/feed' },
    { url: 'https://b.com/feed' },
    { url: 'https://c.com/feed' }
  ]
  const idx = pending.findIndex(f => f.url === 'https://b.com/feed')
  const remaining = pending.filter((_, i) => i !== idx)
  t.is(pending.length, 3)
  t.is(remaining.length, 2)
  t.ok(remaining.every(f => f.url !== 'https://b.com/feed'))
})

test('pending filter: removing first item leaves rest in order', async t => {
  const pending = [{ url: 'https://a.com' }, { url: 'https://b.com' }, { url: 'https://c.com' }]
  const remaining = pending.filter((_, i) => i !== 0)
  t.is(remaining[0].url, 'https://b.com')
  t.is(remaining[1].url, 'https://c.com')
})

test('pending filter: removing last item leaves rest intact', async t => {
  const pending = [{ url: 'https://a.com' }, { url: 'https://b.com' }, { url: 'https://c.com' }]
  const remaining = pending.filter((_, i) => i !== 2)
  t.is(remaining.length, 2)
  t.is(remaining[1].url, 'https://b.com')
})

// ── approve: playlist source dedup using Set ──────────────────────────────────

test('approve: Set deduplicates existing source on add', async t => {
  const existing = ['https://a.com/feed', 'https://b.com/feed']
  const newUrl = 'https://a.com/feed'
  const sources = [...new Set([...existing, newUrl])]
  t.is(sources.length, 2)
})

test('approve: Set preserves new unique source', async t => {
  const existing = ['https://a.com/feed']
  const newUrl = 'https://b.com/feed'
  const sources = [...new Set([...existing, newUrl])]
  t.is(sources.length, 2)
  t.ok(sources.includes('https://b.com/feed'))
})

// ── safeUrl (feedParser) ──────────────────────────────────────────────────────

test('safeUrl: returns empty string for null/undefined', t => {
  t.is(safeUrl(null), '')
  t.is(safeUrl(undefined), '')
  t.is(safeUrl(''), '')
})

test('safeUrl: returns empty string for non-http(s) protocols', t => {
  t.is(safeUrl('javascript:alert(1)'), '')
  t.is(safeUrl('data:text/html,<script>alert(1)</script>'), '')
  t.is(safeUrl('ftp://example.com/file'), '')
})

test('safeUrl: returns empty string for invalid URL', t => {
  t.is(safeUrl('not a url'), '')
  t.is(safeUrl('//no-protocol'), '')
})

test('safeUrl: allows http and https URLs', t => {
  t.ok(safeUrl('https://example.com/image.jpg').startsWith('https://'))
  t.ok(safeUrl('http://example.com/image.jpg').startsWith('http://'))
})

test('safeUrl: escapes & in URL', t => {
  t.ok(safeUrl('https://example.com/?a=1&b=2').includes('&amp;'))
})

test('safeUrl: escapes double-quote to prevent attribute injection', t => {
  t.ok(safeUrl('https://example.com/path"onload=alert(1)').includes('&quot;'))
})

test('safeUrl: escapes single-quote', t => {
  t.ok(safeUrl("https://example.com/path'xss").includes('&#39;'))
})

test('safeUrl: escapes < and >', t => {
  const result = safeUrl('https://example.com/<script>')
  t.ok(result.includes('&lt;'))
  t.ok(result.includes('&gt;'))
})

test('safeUrl: clean URL passes through unchanged', t => {
  t.is(safeUrl('https://example.com/image.jpg'), 'https://example.com/image.jpg')
})
