// Verifies the cron's write paths only touch rows that actually changed.
import { unit as test } from '../testpup.js'
import { makeDb, rows } from '../helpers/db.js'
import { savePostTags } from '../../worker/db-search.js'
import { saveMentions, getMentionsForUrl, getSourceMentionCounts } from '../../worker/db-mentions.js'
import { handleMentionsFeed } from '../../worker/mentions.js'
import { buildLinkGraph } from '../../worker/link-graph.js'
import { saveFeed } from '../../worker/db-feeds.js'
import { saveCandidates, getCandidates, savePending, getPending } from '../../worker/db-moderation.js'

const posts = (spec) => spec.map(([url, tags, date]) => ({ url, tags, date }))

test('savePostTags: first write inserts, identical re-run writes nothing', async t => {
  const db = makeDb()
  const fetched = posts([['https://a.test/1', ['x', 'y'], '2026-10-01'], ['https://a.test/2', ['x'], '2026-10-02']])
  await savePostTags(db, 'https://a.test/feed', fetched)
  t.is(rows(db, 'SELECT * FROM post_tags').length, 3)

  db.changes = 0
  await savePostTags(db, 'https://a.test/feed', fetched)
  t.is(db.changes, 0)
})

test('savePostTags: removed tags are deleted, new ones added, others untouched', async t => {
  const db = makeDb()
  await savePostTags(db, 'https://a.test/feed', posts([['https://a.test/1', ['x', 'y'], '2026-10-01']]))
  db.changes = 0
  await savePostTags(db, 'https://a.test/feed', posts([['https://a.test/1', ['x', 'z'], '2026-10-01']]))
  t.is(db.changes, 2) // delete y + insert z, x untouched
  t.deepEqual(rows(db, 'SELECT tag FROM post_tags ORDER BY tag').map(r => r.tag), ['x', 'z'])
})

test('savePostTags: a post that vanishes from the feed loses its tags; other sources are untouched', async t => {
  const db = makeDb()
  await savePostTags(db, 'https://b.test/feed', posts([['https://b.test/1', ['keep'], '2026-10-01']]))
  await savePostTags(db, 'https://a.test/feed', posts([['https://a.test/1', ['x'], '2026-10-01']]))
  await savePostTags(db, 'https://a.test/feed', [])
  t.deepEqual(rows(db, 'SELECT source_url FROM post_tags').map(r => r.source_url), ['https://b.test/feed'])
})

const mention = (post, extra = {}) => ({
  fromSource: 'https://a.test/feed',
  fromPost: post,
  fromTitle: 'T',
  fromDate: '2026-10-01',
  fromContent: '<p>hi</p>',
  toUrl: 'https://bob.test/x',
  ...extra
})

test('saveMentions: identical re-run writes nothing and preserves found_at', async t => {
  const db = makeDb()
  const list = [mention('https://a.test/p1'), mention('https://a.test/p2')]
  await saveMentions(db, 'bob.test', list)
  db.sqlite.exec("UPDATE mentions SET found_at = '2020-01-01 00:00:00'")

  db.changes = 0
  await saveMentions(db, 'bob.test', list)
  t.is(db.changes, 0)
  t.deepEqual(rows(db, 'SELECT DISTINCT found_at FROM mentions').map(r => r.found_at), ['2020-01-01 00:00:00'])
})

test('saveMentions: inserts new, deletes dropped, updates edited, leaves the rest', async t => {
  const db = makeDb()
  await saveMentions(db, 'bob.test', [mention('https://a.test/p1'), mention('https://a.test/p2'), mention('https://a.test/p3')])
  db.changes = 0
  await saveMentions(db, 'bob.test', [
    mention('https://a.test/p1'), // unchanged
    mention('https://a.test/p2', { fromTitle: 'Edited' }), // updated
    mention('https://a.test/p4') // new; p3 dropped
  ])
  const byPost = Object.fromEntries(rows(db, 'SELECT from_post, from_title FROM mentions').map(r => [r.from_post, r.from_title]))
  t.deepEqual(byPost, { 'https://a.test/p1': 'T', 'https://a.test/p2': 'Edited', 'https://a.test/p4': 'T' })
})

// a roundup post linking three of bob's posts is three mentions, not one
test('saveMentions: one post linking several urls on the same domain keeps them all', async t => {
  const db = makeDb()
  await saveMentions(db, 'bob.test', [
    mention('https://a.test/roundup', { toUrl: 'https://bob.test/x' }),
    mention('https://a.test/roundup', { toUrl: 'https://bob.test/y' }),
    mention('https://a.test/roundup', { toUrl: 'https://bob.test/z' })
  ])
  t.deepEqual(rows(db, 'SELECT to_url FROM mentions ORDER BY to_url').map(r => r.to_url),
    ['https://bob.test/x', 'https://bob.test/y', 'https://bob.test/z'])
})

test('saveMentions: diffing is per (from_post, to_url), not per post', async t => {
  const db = makeDb()
  await saveMentions(db, 'bob.test', [
    mention('https://a.test/roundup', { toUrl: 'https://bob.test/x' }),
    mention('https://a.test/roundup', { toUrl: 'https://bob.test/y' })
  ])
  db.changes = 0
  await saveMentions(db, 'bob.test', [
    mention('https://a.test/roundup', { toUrl: 'https://bob.test/x' }), // unchanged
    mention('https://a.test/roundup', { toUrl: 'https://bob.test/z' }) // new; y dropped
  ])
  t.is(db.changes, 2) // delete y + insert z, x untouched
  t.deepEqual(rows(db, 'SELECT to_url FROM mentions ORDER BY to_url').map(r => r.to_url),
    ['https://bob.test/x', 'https://bob.test/z'])
})

// alvinashcraft.com's feed started spelling its own urls with www. and
// every mention doubled - identity has to survive cosmetic url drift
test('saveMentions: a www/raw respelling of the same post replaces, not duplicates', async t => {
  const db = makeDb()
  await saveMentions(db, 'bob.test', [mention('https://a.test/p1')])
  await saveMentions(db, 'bob.test', [mention('https://www.a.test/p1/')])
  const stored = rows(db, 'SELECT from_post FROM mentions')
  t.is(stored.length, 1)
})

test('saveMentions: an already-doubled pair heals down to one row', async t => {
  const db = makeDb()
  // simulate the damage: both spellings already stored (old code let them in)
  db.sqlite.exec("INSERT INTO mentions (from_source, from_post, from_title, to_domain, to_url) VALUES ('https://a.test/feed', 'https://a.test/p1', 'T', 'bob.test', 'https://bob.test/x')")
  db.sqlite.exec("INSERT INTO mentions (from_source, from_post, from_title, to_domain, to_url) VALUES ('https://a.test/feed', 'https://www.a.test/p1/', 'T', 'bob.test', 'https://bob.test/x')")
  await saveMentions(db, 'bob.test', [mention('https://www.a.test/p1/')])
  t.is(rows(db, 'SELECT from_post FROM mentions').length, 1)
})

test('saveMentions: only touches the given domain', async t => {
  const db = makeDb()
  await saveMentions(db, 'bob.test', [mention('https://a.test/p1')])
  await saveMentions(db, 'carol.test', [mention('https://a.test/p1', { toUrl: 'https://carol.test/' })])
  await saveMentions(db, 'bob.test', [])
  t.deepEqual(rows(db, 'SELECT to_domain FROM mentions').map(r => r.to_domain), ['carol.test'])
})

test('getMentionsForUrl: returns only mentions of that page, matched loosely', async t => {
  const db = makeDb()
  await saveMentions(db, 'bob.test', [
    mention('https://a.test/p1', { toUrl: 'https://bob.test/x' }),
    mention('https://a.test/p2', { toUrl: 'http://www.bob.test/x/?utm_source=feed' }),
    mention('https://a.test/p3', { toUrl: 'https://bob.test/other' })
  ])
  const hits = await getMentionsForUrl(db, 'https://bob.test/x')
  t.deepEqual(hits.map(h => h.url).sort(), ['https://a.test/p1', 'https://a.test/p2'])
  t.is(hits[0].title, 'T')
  t.is(hits[0].source, 'a.test')
})

test('getMentionsForUrl: no match or garbage url returns empty', async t => {
  const db = makeDb()
  await saveMentions(db, 'bob.test', [mention('https://a.test/p1', { toUrl: 'https://bob.test/x' })])
  t.deepEqual(await getMentionsForUrl(db, 'https://bob.test/nope'), [])
  t.deepEqual(await getMentionsForUrl(db, 'not a url'), [])
})

test('buildLinkGraph: every distinct link to a domain becomes its own mention', async t => {
  const db = makeDb()
  const sources = ['https://a.test/feed', 'https://bob.test/feed']
  const freshData = new Map([
    ['https://a.test/feed', {
      posts: [{
        url: 'https://a.test/roundup',
        title: 'Roundup',
        date: '2026-10-01',
        content: '<p><a href="https://bob.test/x">x</a> and <a href="https://bob.test/y">y</a> and <a href="https://bob.test/x">x again</a></p>'
      }]
    }]
  ])
  await buildLinkGraph(db, sources, freshData)
  t.deepEqual(rows(db, 'SELECT to_url FROM mentions ORDER BY to_url').map(r => r.to_url),
    ['https://bob.test/x', 'https://bob.test/y'])
})

test('buildLinkGraph: a re-run keeps found_at and writes nothing new', async t => {
  const db = makeDb()
  const sources = ['https://a.test/feed', 'https://bob.test/feed']
  const freshData = new Map([
    ['https://a.test/feed', {
      posts: [{ url: 'https://a.test/p1', title: 'T', date: '2026-10-01', content: '<a href="https://bob.test/x">x</a>' }]
    }]
  ])
  await buildLinkGraph(db, sources, freshData)
  db.sqlite.exec("UPDATE mentions SET found_at = '2020-01-01T00:00:00.000Z'")
  db.changes = 0
  await buildLinkGraph(db, sources, freshData)
  t.is(db.changes, 0)
  t.deepEqual(rows(db, 'SELECT found_at FROM mentions').map(r => r.found_at), ['2020-01-01T00:00:00.000Z'])
})

test('buildLinkGraph: url drift in the source feed does not double mentions', async t => {
  const db = makeDb()
  const sources = ['https://a.test/feed', 'https://bob.test/feed']
  const post = (url) => ({ url, title: 'T', date: '2026-10-01', content: '<a href="https://bob.test/x">x</a>' })
  await buildLinkGraph(db, sources, new Map([['https://a.test/feed', { posts: [post('https://a.test/p1')] }]]))
  await buildLinkGraph(db, sources, new Map([['https://a.test/feed', { posts: [post('https://www.a.test/p1/')] }]]))
  t.is(rows(db, 'SELECT from_post FROM mentions').length, 1)
})

// the may dew drop left the feed window months ago - a rebuild never
// re-harvests it, so healing has to happen among the kept rows themselves
test('buildLinkGraph: historical rows that are the same post respelled collapse to the newest', async t => {
  const db = makeDb()
  const sources = ['https://a.test/feed', 'https://fresh.test/feed', 'https://bob.test/feed']
  db.sqlite.exec("INSERT INTO mentions (from_source, from_post, from_title, from_date, to_domain, to_url, found_at) VALUES ('https://a.test/feed', 'https://www.a.test/old-post/', 'Old spelling', '2026-05-11', 'bob.test', 'https://bob.test/x', '2026-05-11T00:00:00.000Z')")
  db.sqlite.exec("INSERT INTO mentions (from_source, from_post, from_title, from_date, to_domain, to_url, found_at) VALUES ('https://a.test/feed', 'https://a.test/old-post', 'New spelling', '2026-05-11', 'bob.test', 'https://bob.test/x', '2026-06-01T00:00:00.000Z')")
  // an unrelated fresh mention of bob.test triggers the merge for that domain
  await buildLinkGraph(db, sources, new Map([['https://fresh.test/feed', {
    posts: [{ url: 'https://fresh.test/p1', title: 'F', date: '2026-11-01', content: '<a href="https://bob.test/y">y</a>' }]
  }]]))
  const stored = rows(db, "SELECT from_post, from_title FROM mentions WHERE to_url='https://bob.test/x'")
  t.is(stored.length, 1)
  t.is(stored[0].from_title, 'New spelling') // newest found_at wins
})

// no source-membership pruning - a row from a source that's gone (or just
// respelled its feed url) stays. the prune that existed briefly ate two
// real finest.day mentions because the feed url drifted.
test('buildLinkGraph: rows from a source no longer listed survive', async t => {
  const db = makeDb()
  const sources = ['https://fresh.test/feed', 'https://bob.test/feed']
  db.sqlite.exec("INSERT INTO mentions (from_source, from_post, from_title, from_date, to_domain, to_url, found_at) VALUES ('https://gone.test/feed', 'https://gone.test/p1', 'Ghost', '2026-05-06', 'bob.test', 'https://bob.test/x', '2026-05-06T00:00:00.000Z')")
  await buildLinkGraph(db, sources, new Map([['https://fresh.test/feed', {
    posts: [{ url: 'https://fresh.test/p1', title: 'F', date: '2026-11-01', content: '<a href="https://bob.test/y">y</a>' }]
  }]]))
  t.is(rows(db, "SELECT * FROM mentions WHERE from_post='https://gone.test/p1'").length, 1)
})

// the real brine.dev case: no current-window post links the domain at all,
// so it never shows up in the fresh harvest - it has to heal anyway
test('buildLinkGraph: a domain with only historical mentions still heals', async t => {
  const db = makeDb()
  const sources = ['https://a.test/feed', 'https://fresh.test/feed', 'https://bob.test/feed', 'https://carol.test/feed']
  db.sqlite.exec("INSERT INTO mentions (from_source, from_post, from_title, from_date, to_domain, to_url, found_at) VALUES ('https://a.test/feed', 'https://www.a.test/old-post/', 'Old spelling', '2026-05-11', 'bob.test', 'https://bob.test/x', '2026-05-11T00:00:00.000Z')")
  db.sqlite.exec("INSERT INTO mentions (from_source, from_post, from_title, from_date, to_domain, to_url, found_at) VALUES ('https://a.test/feed', 'https://a.test/old-post', 'New spelling', '2026-05-11', 'bob.test', 'https://bob.test/x', '2026-06-01T00:00:00.000Z')")
  // fresh harvest mentions carol.test only - bob.test is nowhere in it
  await buildLinkGraph(db, sources, new Map([['https://fresh.test/feed', {
    posts: [{ url: 'https://fresh.test/p1', title: 'F', date: '2026-11-01', content: '<a href="https://carol.test/y">y</a>' }]
  }]]))
  t.is(rows(db, "SELECT * FROM mentions WHERE to_domain='bob.test'").length, 1)
})

const feed = (extra = {}) => ({
  id: 'f1',
  title: 'Cool',
  description: 'd',
  tags: ['a'],
  sources: ['https://a.test/feed', 'https://b.test/feed'],
  previewPosts: [],
  ...extra
})

test('saveFeed: default call syncs sources and the search index', async t => {
  const db = makeDb()
  await saveFeed(db, feed())
  t.is(rows(db, 'SELECT * FROM feed_sources').length, 2)
  t.is(rows(db, "SELECT * FROM feeds_fts WHERE feed_id = 'f1'").length, 1)
})

test('saveFeed: syncChildren false updates the feed row only', async t => {
  const db = makeDb()
  await saveFeed(db, feed())
  db.changes = 0
  await saveFeed(db, feed({ previewPosts: [{ title: 'new post' }], lastUpdated: '2026-10-18T00:00:00Z' }), { syncChildren: false })
  t.is(db.changes, 1)
  t.ok(rows(db, "SELECT preview_posts FROM feeds WHERE id = 'f1'")[0].preview_posts.includes('new post'))
  t.is(rows(db, 'SELECT * FROM feed_sources').length, 2)
  t.is(rows(db, "SELECT * FROM feeds_fts WHERE feed_id = 'f1'").length, 1)
})

test('saveCandidates: stats and the reject reason survive the round trip, a re-save writes nothing', async t => {
  const db = makeDb()
  const list = [
    { domain: 'good.blog', score: 1, sources: ['a.com'], firstSeen: '2026-11-19', probedAt: '2026-11-19', feedUrl: 'https://good.blog/feed', stats: { posts: 4, linksBack: ['a.com'] }, rejected: null },
    { domain: 'teaser.com', score: 2, sources: ['a.com', 'b.com'], firstSeen: '2026-11-19', probedAt: '2026-11-19', feedUrl: 'https://teaser.com/feed', stats: { posts: 4 }, rejected: 'truncated' }
  ]
  await saveCandidates(db, list)
  const got = await getCandidates(db)
  t.deepEqual(got.find(c => c.domain === 'good.blog').stats.linksBack, ['a.com'])
  t.is(got.find(c => c.domain === 'teaser.com').rejected, 'truncated')

  db.changes = 0
  await saveCandidates(db, got)
  t.is(db.changes, 0)
})

test('savePending: stats ride along on a pending row', async t => {
  const db = makeDb()
  await savePending(db, [{ url: 'https://x.blog/feed', title: 'x', stats: { posts: 3, fullText: true } }, { url: 'https://y.blog/feed', title: 'y' }])
  const got = await getPending(db)
  t.is(got.find(p => p.url === 'https://x.blog/feed').stats.fullText, true)
  t.is(got.find(p => p.url === 'https://y.blog/feed').stats, null)
})

// zacharykai's People and Blogs reposts link both / and /pb - one post, two rows
test('mention count and feed: one post linking two urls counts once', async t => {
  const db = makeDb()
  await saveMentions(db, 'bob.test', [
    mention('https://a.test/pb-1', { toUrl: 'https://bob.test/' }),
    mention('https://a.test/pb-1', { toUrl: 'https://bob.test/pb' }),
    mention('https://a.test/other', { toUrl: 'https://bob.test/' })
  ])
  t.is(rows(db, 'SELECT * FROM mentions').length, 3) // footer embeds still match per url
  t.deepEqual(await getSourceMentionCounts(db), { 'bob.test': 2 })

  const xml = await (await handleMentionsFeed(db, 'bob.test', 'https://discover.brine.dev/api/mentions/bob.test.xml')).text()
  t.is(xml.match(/<item>/g).length, 2)
  t.ok(xml.includes('mentioned <a href="https://bob.test/pb">')) // the specific page wins over /
  t.ok(xml.includes('<a href="https://a.test">a.test</a> mentioned')) // their site, not their feed xml
  t.ok(!xml.includes('href="https://a.test/feed"'))
})
