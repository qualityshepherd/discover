import { unit as test } from '../testpup.js'
import { makeDb } from '../helpers/db.js'
import { DAY, goodPosts, feedOf, makePost, makeFreshData } from '../helpers/feeds.js'
import { buildCurateCandidates, maybeBuildCurateCandidates, PROBES_PER_RUN, findFeedLink, probeFeedUrl } from '../../worker/curate.js'
import { getCandidates, saveCandidates, addDismissedDomain, saveBlocked } from '../../worker/db-moderation.js'

const noProbe = async () => null
const feedProbe = async () => feedOf(goodPosts())

// a real database with some starting state
const seedDb = async ({ candidates = [], dismissed = [], blocked = [] } = {}) => {
  const db = makeDb()
  await saveCandidates(db, candidates)
  for (const d of dismissed) await addDismissedDomain(db, d)
  if (blocked.length) await saveBlocked(db, blocked)
  db.changes = 0
  return db
}

test('buildCurateCandidates: does nothing with empty freshData', async t => {
  const db = await seedDb()
  await buildCurateCandidates(db, [], new Map(), noProbe)
  t.is((await getCandidates(db)).length, 0)
})

test('buildCurateCandidates: skips domains already in sourceUrls', async t => {
  const db = await seedDb()
  const freshData = makeFreshData([['https://source.com/feed', ['https://known.com/some-post']]])
  await buildCurateCandidates(db, ['https://known.com/feed'], freshData, noProbe)
  const candidates = await getCandidates(db)
  t.falsy(candidates.find(c => c.domain === 'known.com'))
})

test('buildCurateCandidates: skips dismissed domains', async t => {
  const db = await seedDb({ dismissed: ['dismissed.com'] })
  const freshData = makeFreshData([['https://source.com/feed', ['https://dismissed.com/post']]])
  await buildCurateCandidates(db, [], freshData, noProbe)
  const candidates = await getCandidates(db)
  t.falsy(candidates.find(c => c.domain === 'dismissed.com'))
})

test('buildCurateCandidates: skips video domains', async t => {
  const db = await seedDb()
  const freshData = makeFreshData([['https://source.com/feed', ['https://youtube.com/watch?v=123']]])
  await buildCurateCandidates(db, [], freshData, noProbe)
  const candidates = await getCandidates(db)
  t.falsy(candidates.find(c => c.domain === 'youtube.com'))
})

test('buildCurateCandidates: skips social/noise domains', async t => {
  const db = await seedDb()
  const freshData = makeFreshData([['https://source.com/feed', ['https://twitter.com/user', 'https://reddit.com/r/foo']]])
  await buildCurateCandidates(db, [], freshData, noProbe)
  const candidates = await getCandidates(db)
  t.falsy(candidates.find(c => c.domain === 'twitter.com' || c.domain === 'reddit.com'))
})

test('buildCurateCandidates: skips self-links', async t => {
  const db = await seedDb()
  const freshData = makeFreshData([['https://source.com/feed', ['https://source.com/other-post']]])
  await buildCurateCandidates(db, [], freshData, noProbe)
  const candidates = await getCandidates(db)
  t.falsy(candidates.find(c => c.domain === 'source.com'))
})

test('buildCurateCandidates: scores by source diversity', async t => {
  const db = await seedDb()
  const freshData = makeFreshData([
    ['https://a.com/feed', ['https://target.com/post']],
    ['https://b.com/feed', ['https://target.com/post']],
    ['https://c.com/feed', ['https://target.com/post']]
  ])
  await buildCurateCandidates(db, [], freshData, feedProbe)
  const candidates = await getCandidates(db)
  const entry = candidates.find(c => c.domain === 'target.com')
  t.ok(entry)
  t.is(entry.score, 3)
  t.is(entry.sources.length, 3)
})

test('buildCurateCandidates: probe returning feed url goes to candidates', async t => {
  const db = await seedDb()
  const freshData = makeFreshData([['https://source.com/feed', ['https://newblog.com/post']]])
  await buildCurateCandidates(db, [], freshData, feedProbe)
  const candidates = await getCandidates(db)
  const entry = candidates.find(c => c.domain === 'newblog.com')
  t.ok(entry)
  t.is(entry.feedUrl, 'https://found.example.com/feed')
})

test('buildCurateCandidates: limits new probes per run', async t => {
  const db = await seedDb()
  const domains = Array.from({ length: PROBES_PER_RUN + 2 }, (_, i) => `blog${i}.com`)
  const freshData = makeFreshData(
    domains.flatMap(d => [
      [`https://src1-${d}/feed`, [`https://${d}/post`]],
      [`https://src2-${d}/feed`, [`https://${d}/other`]]
    ])
  )
  await buildCurateCandidates(db, [], freshData, feedProbe)
  const candidates = await getCandidates(db)
  t.is(candidates.length, PROBES_PER_RUN)
})

test('buildCurateCandidates: updates score for existing candidate', async t => {
  const db = await seedDb({
    candidates: [{ domain: 'known.com', feedUrl: 'https://known.com/feed', score: 1, sources: ['old.com'], stats: { posts: 3 } }]
  })
  const freshData = makeFreshData([
    ['https://new1.com/feed', ['https://known.com/post']],
    ['https://new2.com/feed', ['https://known.com/post']]
  ])
  await buildCurateCandidates(db, [], freshData, noProbe)
  const candidates = await getCandidates(db)
  const entry = candidates.find(c => c.domain === 'known.com')
  t.ok(entry)
  // old.com from an earlier scan plus new1 and new2 now - votes add up
  t.is(entry.score, 3)
})

test('buildCurateCandidates: a failed probe is remembered, so the next domain gets a turn', async t => {
  const db = await seedDb()
  const domains = ['alpha.com', 'beta.com', 'gamma.com', 'delta.com']
  const freshData = makeFreshData(
    domains.flatMap(d => [
      [`https://src1-${d}/feed`, [`https://${d}/post`]],
      [`https://src2-${d}/feed`, [`https://${d}/other`]]
    ])
  )
  const probed = []
  const probe = async domain => { probed.push(domain); return domain === 'delta.com' ? feedOf(goodPosts(), { feedUrl: 'https://delta.com/feed' }) : null }
  await buildCurateCandidates(db, [], freshData, probe)
  await buildCurateCandidates(db, [], freshData, probe)
  // first run burns 3 feedless domains, second run reaches the 4th
  t.is(probed.length, 4)
  t.ok(probed.includes('delta.com'))
  const found = (await getCandidates(db)).filter(c => c.feedUrl)
  t.is(found.length, 1)
  t.is(found[0].domain, 'delta.com')
})

test('buildCurateCandidates: failed probes retry after a month', async t => {
  const old = new Date(Date.now() - 31 * 86400000).toISOString()
  const db = await seedDb({ candidates: [{ domain: 'late.com', score: 2, sources: [], probedAt: old, feedUrl: null }] })
  const freshData = makeFreshData([
    ['https://a.com/feed', ['https://late.com/post']],
    ['https://b.com/feed', ['https://late.com/post']]
  ])
  await buildCurateCandidates(db, [], freshData, feedProbe)
  const entry = (await getCandidates(db)).find(c => c.domain === 'late.com')
  t.is(entry.feedUrl, 'https://found.example.com/feed')
})

test('saveCandidates: a run that changes nothing writes nothing', async t => {
  const db = await seedDb()
  const freshData = makeFreshData([
    ['https://a.com/feed', ['https://quiet.com/post']],
    ['https://b.com/feed', ['https://quiet.com/post']]
  ])
  await buildCurateCandidates(db, [], freshData, feedProbe)
  const before = db.changes
  await buildCurateCandidates(db, [], freshData, feedProbe)
  t.is(db.changes, before)
})

test('buildCurateCandidates: votes add up across scans that never overlap', async t => {
  const db = await seedDb()
  await buildCurateCandidates(db, [], makeFreshData([['https://a.com/feed', ['https://quiet.com/post']]]), feedProbe)
  await buildCurateCandidates(db, [], makeFreshData([['https://b.com/feed', ['https://quiet.com/post']]]), feedProbe)
  t.is((await getCandidates(db)).find(c => c.domain === 'quiet.com').score, 2)
})

test('maybeBuildCurateCandidates: runs at most once a day', async t => {
  const db = makeDb()
  const fresh = makeFreshData([['https://a.com/feed', ['https://quiet.com/post']]])
  const now = Date.UTC(2026, 10, 18)
  t.is(await maybeBuildCurateCandidates(db, ['https://a.com/feed', 'https://b.com/feed'], fresh, 'x', feedProbe, now), true)
  t.is(await maybeBuildCurateCandidates(db, [], fresh, 'x', feedProbe, now + 3600000), false)
  t.is(await maybeBuildCurateCandidates(db, [], fresh, 'x', feedProbe, now + 86400000), true)
})

test('buildCurateCandidates: one blog with two curated feeds is one vote', async t => {
  const db = await seedDb()
  const freshData = makeFreshData([
    ['https://manu.com/feed', ['https://quiet.com/post']],
    ['https://manu.com/podcast.xml', ['https://quiet.com/post']]
  ])
  await buildCurateCandidates(db, [], freshData, feedProbe)
  t.is((await getCandidates(db)).find(c => c.domain === 'quiet.com').score, 1)
})

test('buildCurateCandidates: blocked domains never become candidates', async t => {
  const db = await seedDb({ blocked: ['spam.com'] })
  const freshData = makeFreshData([
    ['https://a.com/feed', ['https://sub.spam.com/post']],
    ['https://b.com/feed', ['https://sub.spam.com/post']]
  ])
  await buildCurateCandidates(db, [], freshData, feedProbe)
  t.is((await getCandidates(db)).length, 0)
})

test('buildCurateCandidates: blocking an existing candidate drops it', async t => {
  const db = await seedDb({
    blocked: ['gone.com'],
    candidates: [{ domain: 'gone.com', score: 2, sources: [], feedUrl: 'https://gone.com/feed' }]
  })
  const freshData = makeFreshData([['https://a.com/feed', ['https://other.com/post']]])
  await buildCurateCandidates(db, [], freshData, noProbe)
  t.ok(!(await getCandidates(db)).find(c => c.domain === 'gone.com'))
})

test('buildCurateCandidates: mailto and other non-web links are not votes', async t => {
  const db = await seedDb()
  const probed = []
  const freshData = makeFreshData([
    ['https://a.com/feed', ['mailto:me@a.com', 'tel:555', 'https://real.com/post']],
    ['https://b.com/feed', ['mailto:you@b.com', 'https://real.com/post']]
  ])
  await buildCurateCandidates(db, [], freshData, async d => { probed.push(d); return null })
  t.is(probed.join(), 'real.com')
})

test('buildCurateCandidates: platform roots are skipped, blogs on them are not', async t => {
  const db = await seedDb()
  const probed = []
  const freshData = makeFreshData([
    ['https://a.com/feed', ['https://substack.com/x', 'https://medium.com/@x', 'https://someone.substack.com/p/y']],
    ['https://b.com/feed', ['https://substack.com/x', 'https://someone.substack.com/p/z']]
  ])
  await buildCurateCandidates(db, [], freshData, async d => { probed.push(d); return null })
  t.is(probed.join(), 'someone.substack.com')
})

test('buildCurateCandidates: stored rows that are now skip-listed get cleaned out', async t => {
  const recent = new Date().toISOString()
  const db = await seedDb({
    candidates: [
      { domain: '', score: 26, sources: [], probedAt: recent, feedUrl: null },
      { domain: 'medium.com', score: 13, sources: [], probedAt: recent, feedUrl: null }
    ]
  })
  await buildCurateCandidates(db, [], makeFreshData([['https://a.com/feed', ['https://other.com/post']]]), noProbe)
  const left = (await getCandidates(db)).map(c => c.domain)
  t.ok(!left.includes(''))
  t.ok(!left.includes('medium.com'))
})

test('buildCurateCandidates: blogs sharing a feed host are separate votes', async t => {
  const db = await seedDb()
  const freshData = new Map([
    ['https://feeds.feedburner.com/one', { siteUrl: 'https://one.blog/', posts: [makePost(['https://quiet.com/a'])] }],
    ['https://feeds.feedburner.com/two', { siteUrl: 'https://two.blog/', posts: [makePost(['https://quiet.com/b'])] }]
  ])
  await buildCurateCandidates(db, [...freshData.keys()], freshData, feedProbe)
  const entry = (await getCandidates(db)).find(c => c.domain === 'quiet.com')
  t.is(entry.score, 2)
  t.is(entry.sources.sort().join(), 'one.blog,two.blog')
})

test('buildCurateCandidates: a curated blog on a feed host is not a candidate for itself', async t => {
  const db = await seedDb()
  const freshData = new Map([
    ['https://feedpress.me/mine', { siteUrl: 'https://mine.blog/', posts: [makePost(['https://other.com/x'])] }],
    ['https://a.com/feed', { posts: [makePost(['https://mine.blog/post'])] }],
    ['https://b.com/feed', { posts: [makePost(['https://mine.blog/post'])] }]
  ])
  await buildCurateCandidates(db, [...freshData.keys()], freshData, feedProbe)
  t.ok(!(await getCandidates(db)).find(c => c.domain === 'mine.blog'))
})

test('buildCurateCandidates: legacy feed-url votes are dropped for blog domains', async t => {
  const db = await seedDb({
    candidates: [{ domain: 'quiet.com', feedUrl: 'https://quiet.com/feed', score: 2, sources: ['https://feeds.feedburner.com/one', 'two.blog'] }]
  })
  const freshData = new Map([
    ['https://feeds.feedburner.com/one', { siteUrl: 'https://one.blog/', posts: [makePost(['https://quiet.com/a'])] }]
  ])
  await buildCurateCandidates(db, [...freshData.keys()], freshData, noProbe)
  const entry = (await getCandidates(db)).find(c => c.domain === 'quiet.com')
  t.is(entry.sources.sort().join(), 'one.blog,two.blog')
  t.is(entry.score, 2)
})

test('findFeedLink: attribute order does not matter', t => {
  const base = 'https://site.com/'
  t.is(findFeedLink('<link rel="alternate" type="application/rss+xml" href="/feed.xml">', base), 'https://site.com/feed.xml')
  t.is(findFeedLink('<link href="/atom" rel="alternate" type="application/atom+xml">', base), 'https://site.com/atom')
  t.is(findFeedLink('<link href="https://feeds.example.com/x?a=1&amp;b=2" type="application/rss+xml">', base), 'https://feeds.example.com/x?a=1&b=2')
  t.is(findFeedLink('<link rel="stylesheet" href="/s.css">', base), null)
})

const fakeFetch = pages => async url => {
  const page = pages[url]
  if (!page) return new Response('nope', { status: 404 })
  return new Response(page.body, { status: 200, headers: { 'content-type': page.type || 'text/html' } })
}

test('probeFeedUrl: a guessed path that says xml but is not a feed is rejected', async t => {
  const f = fakeFetch({
    'https://app.com': { body: '<html>no feed links</html>' },
    'https://app.com/atom.xml': { body: '<html>sign in to continue</html>', type: 'application/xhtml+xml' }
  })
  t.is(await probeFeedUrl('app.com', 'x', f), null)
})

test('probeFeedUrl: a declared feed is used once its body checks out', async t => {
  const f = fakeFetch({
    'https://blog.com': { body: '<link href="/posts.xml" type="application/rss+xml">' },
    'https://blog.com/posts.xml': { body: '<?xml version="1.0"?><rss version="2.0"><channel>', type: 'application/rss+xml' }
  })
  t.is(await probeFeedUrl('blog.com', 'x', f), 'https://blog.com/posts.xml')
})

test('probeFeedUrl: falls back to a guessed path that really is a feed', async t => {
  const f = fakeFetch({
    'https://quiet.com': { body: '<html></html>' },
    'https://quiet.com/index.xml': { body: '<feed xmlns="http://www.w3.org/2005/Atom">', type: 'text/xml' }
  })
  t.is(await probeFeedUrl('quiet.com', 'x', f), 'https://quiet.com/index.xml')
})

test('buildCurateCandidates: fewest votes get probed first', async t => {
  const db = await seedDb()
  const freshData = makeFreshData([
    ['https://a.com/feed', ['https://mag.com/1', 'https://friend.blog/1']],
    ['https://b.com/feed', ['https://mag.com/2']],
    ['https://c.com/feed', ['https://mag.com/3']]
  ])
  const probed = []
  await buildCurateCandidates(db, [], freshData, async d => { probed.push(d); return null })
  t.is(probed[0], 'friend.blog')
})

test('buildCurateCandidates: ties are shuffled, not probed in scan order', async t => {
  const db = await seedDb()
  const freshData = makeFreshData([['https://a.com/feed', ['https://first.com/1', 'https://second.com/1', 'https://third.com/1']]])
  const probed = []
  await buildCurateCandidates(db, [], freshData, async d => { probed.push(d); return null }, 'x', () => 0)
  t.not(probed[0], 'first.com')
  t.is(probed.length, 3)
})

const twoVotes = domain => makeFreshData([
  ['https://a.com/feed', [`https://${domain}/post`]],
  ['https://b.com/feed', [`https://${domain}/post`]]
])

test('buildCurateCandidates: a machine no is kept with its reason, not dropped', async t => {
  const db = await seedDb()
  await buildCurateCandidates(db, [], twoVotes('teaser.com'), async () => feedOf(goodPosts(4, { len: 50 })))
  const entry = (await getCandidates(db)).find(c => c.domain === 'teaser.com')
  t.is(entry.rejected, 'truncated')
  t.is(entry.feedUrl, 'https://found.example.com/feed')
})

test('buildCurateCandidates: a machine no is rechecked after 90 days, not before', async t => {
  const probed = []
  const probe = async d => { probed.push(d); return feedOf(goodPosts()) }
  const at = days => new Date(Date.now() - days * DAY).toISOString()
  const row = days => ({ domain: 'teaser.com', score: 2, sources: ['a.com', 'b.com'], probedAt: at(days), feedUrl: 'https://teaser.com/feed', stats: { posts: 4 }, rejected: 'truncated' })

  await buildCurateCandidates(await seedDb({ candidates: [row(60)] }), [], twoVotes('teaser.com'), probe)
  t.is(probed.length, 0)

  const db = await seedDb({ candidates: [row(91)] })
  await buildCurateCandidates(db, [], twoVotes('teaser.com'), probe)
  t.is(probed.join(), 'teaser.com')
  t.is((await getCandidates(db))[0].rejected, null)
})

test('buildCurateCandidates: a row from before the checks gets read once', async t => {
  const probed = []
  const db = await seedDb({ candidates: [{ domain: 'old.com', score: 2, sources: ['a.com', 'b.com'], firstSeen: '2026-01-01T00:00:00.000Z', feedUrl: 'https://old.com/feed' }] })
  await buildCurateCandidates(db, [], twoVotes('old.com'), async d => { probed.push(d); return feedOf(goodPosts()) })
  const entry = (await getCandidates(db))[0]
  t.is(probed.join(), 'old.com')
  t.ok(entry.stats)
  t.is(entry.firstSeen, '2026-01-01T00:00:00.000Z')
})

test('buildCurateCandidates: link-backs are counted against discover blogs', async t => {
  const db = await seedDb()
  const extra = '<a href="https://a.com/x">a</a>'
  await buildCurateCandidates(db, ['https://a.com/feed', 'https://b.com/feed'], twoVotes('neighbor.com'), async () => feedOf(goodPosts(4, { extra })))
  t.deepEqual((await getCandidates(db))[0].stats.linksBack, ['a.com'])
})

test('buildCurateCandidates: the rebuild button takes a bigger bite', async t => {
  const db = await seedDb()
  const domains = Array.from({ length: 12 }, (_, i) => `blog${i}.com`)
  const freshData = makeFreshData([['https://a.com/feed', domains.map(d => `https://${d}/p`)]])
  const res = await buildCurateCandidates(db, [], freshData, feedProbe, 'x', Math.random, { probes: 10 })
  t.is(res.probed, 10)
  t.is(res.passed, 10)
  t.is((await getCandidates(db)).length, 10)
})

test('buildCurateCandidates: nothing is capped away', async t => {
  const db = await seedDb()
  const domains = Array.from({ length: 160 }, (_, i) => `blog${i}.com`)
  const freshData = makeFreshData([['https://a.com/feed', domains.map(d => `https://${d}/p`)]])
  await buildCurateCandidates(db, [], freshData, noProbe, 'x', Math.random, { probes: 160 })
  t.is((await getCandidates(db)).length, 160)
})
