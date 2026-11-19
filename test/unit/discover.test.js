import { unit as test } from '../testpup.js'
import { computeFrequency, makeId, computeTags } from '../../worker/discover.js'
import { sameBlog } from '../../worker/utils.js'
import { isFullText, feedStats, rejectReason, statsLine } from '../../worker/feed-stats.js'
import { buildCurateCandidates, maybeBuildCurateCandidates, readLimitedText, PROBES_PER_RUN, blogDomain, findFeedLink, probeFeedUrl, feedInfo } from '../../worker/discover-cron.js'
import { isBlocked, isUrlBlocked, getCandidates } from '../../worker/db-moderation.js'

// isBlocked
//
const fakeBlockedDb = (list) => ({
  prepare: () => ({ all: async () => ({ results: list.map(d => ({ domain: d })) }) })
})

test('isBlocked: returns false when blocked list is empty', async t => {
  t.falsy(await isBlocked(fakeBlockedDb([]), ['https://example.com/feed.xml']))
})

test('isBlocked: matches full URL substring', async t => {
  t.ok(await isBlocked(fakeBlockedDb(['badsite.com']), ['https://badsite.com/feed.xml']))
})

test('isBlocked: matches hostname with www stripped', async t => {
  t.ok(await isBlocked(fakeBlockedDb(['badsite.com']), ['https://www.badsite.com/feed.xml']))
})

test('isBlocked: does not block unrelated domain', async t => {
  t.falsy(await isBlocked(fakeBlockedDb(['badsite.com']), ['https://goodsite.com/feed.xml']))
})

test('isBlocked: returns true if any source matches', async t => {
  t.ok(await isBlocked(fakeBlockedDb(['badsite.com']), ['https://ok.com/feed.xml', 'https://badsite.com/feed.xml']))
})

test('isBlocked: handles invalid url without throwing', async t => {
  t.falsy(await isBlocked(fakeBlockedDb(['badsite.com']), ['not-a-url']))
})

// isUrlBlocked — hostname-exact-or-subdomain match, not a bare substring
// check. Regression coverage for the handleValidate bug where an inline
// url.includes(b)/hostname.includes(b) check would wrongly match domains
// that merely contain a blocked domain as a substring.
test('isUrlBlocked: exact hostname match', t => {
  t.ok(isUrlBlocked('https://badsite.com/feed.xml', ['badsite.com']))
})

test('isUrlBlocked: does not match a domain that merely contains the blocked domain as a substring', t => {
  t.falsy(isUrlBlocked('https://notbadsite.com/feed.xml', ['badsite.com']))
  t.falsy(isUrlBlocked('https://badsite.com.evil.org/feed.xml', ['badsite.com']))
})

test('isUrlBlocked: matches a real subdomain', t => {
  t.ok(isUrlBlocked('https://feed.badsite.com/feed.xml', ['badsite.com']))
})

// makeId

test('makeId: same url returns same id', t => {
  t.is(makeId('https://example.com/feed.xml'), makeId('https://example.com/feed.xml'))
})

test('makeId: different urls return different ids', t => {
  t.not(makeId('https://example.com/feed.xml'), makeId('https://other.com/feed.xml'))
})

test('makeId: returns non-empty string', t => {
  t.ok(makeId('https://example.com').length > 0)
})

// computeTags

test('computeTags: counts tags across feeds', t => {
  const feeds = [
    { tags: ['tech', 'essays'] },
    { tags: ['tech', 'science'] },
    { tags: ['essays'] }
  ]
  const result = computeTags(feeds)
  const techEntry = result.find(r => r.tag === 'tech')
  const essaysEntry = result.find(r => r.tag === 'essays')
  t.is(techEntry.count, 2)
  t.is(essaysEntry.count, 2)
})

test('computeTags: sorts by count descending', t => {
  const feeds = [
    { tags: ['rare'] },
    { tags: ['common', 'common2'] },
    { tags: ['common'] },
    { tags: ['common'] }
  ]
  const result = computeTags(feeds)
  t.is(result[0].tag, 'common')
})

test('computeTags: handles feeds with no tags', t => {
  const feeds = [{ tags: ['tech'] }, {}, { tags: null }]
  const result = computeTags(feeds)
  t.is(result.length, 1)
  t.is(result[0].tag, 'tech')
})

test('computeTags: empty feeds returns empty array', t => {
  t.deepEqual(computeTags([]), [])
})

// computeFrequency

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()

test('computeFrequency: no posts returns null', t => {
  t.is(computeFrequency([]), null)
  t.is(computeFrequency(null), null)
})

test('computeFrequency: all posts older than 90 days returns inactive', t => {
  const posts = Array.from({ length: 5 }, () => ({ date: daysAgo(100) }))
  t.is(computeFrequency(posts), 'inactive')
})

test('computeFrequency: 20+ posts in 90 days returns daily', t => {
  const posts = Array.from({ length: 25 }, () => ({ date: daysAgo(5) }))
  t.is(computeFrequency(posts), 'daily')
})

test('computeFrequency: 8-19 posts in 90 days returns weekly', t => {
  const posts = Array.from({ length: 10 }, () => ({ date: daysAgo(10) }))
  t.is(computeFrequency(posts), 'weekly')
})

test('computeFrequency: 2-7 posts in 90 days returns monthly', t => {
  const posts = Array.from({ length: 3 }, () => ({ date: daysAgo(15) }))
  t.is(computeFrequency(posts), 'monthly')
})

test('computeFrequency: 1 post in 90 days returns inactive', t => {
  const posts = [{ date: daysAgo(15) }]
  t.is(computeFrequency(posts), 'inactive')
})

test('computeFrequency: posts with no date are ignored', t => {
  const posts = [{ date: null }, { date: '' }, { date: daysAgo(5) }, { date: daysAgo(10) }]
  t.is(computeFrequency(posts), 'monthly')
})

test('computeFrequency: exactly 20 posts returns daily', t => {
  const posts = Array.from({ length: 20 }, () => ({ date: daysAgo(1) }))
  t.is(computeFrequency(posts), 'daily')
})

test('computeFrequency: exactly 8 posts returns weekly', t => {
  const posts = Array.from({ length: 8 }, () => ({ date: daysAgo(1) }))
  t.is(computeFrequency(posts), 'weekly')
})

// isFullText - discover's full-text rule

const long = '<p>' + 'word '.repeat(160) + '</p>'

test('isFullText: nothing to read is not full text', t => {
  t.falsy(isFullText([]))
  t.falsy(isFullText(null))
  t.falsy(isFullText([{ content: '' }]))
})

test('isFullText: whole posts pass', t => {
  t.ok(isFullText([{ content: long }, { content: long }, { content: '<p>short note</p>' }]))
})

test('isFullText: posts ending in read more are excerpts, however long', t => {
  const teaser = { content: long + '<a href="/p">Continue reading &rarr;</a>' }
  t.falsy(isFullText([teaser, teaser, { content: long }]))
  t.falsy(isFullText([{ content: long + ' [&hellip;]' }, { content: long + '...' }]))
})

test('isFullText: a typical post too short to be the whole thing fails', t => {
  t.falsy(isFullText(Array.from({ length: 5 }, () => ({ content: '<p>A two-line summary of the post.</p>' }))))
})

// readLimitedText — enforces fetchSource's response-size cap by counting
// streamed bytes, not trusting Content-Length.
const streamOf = (chunks) => new Response(new ReadableStream({
  start (controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
    controller.close()
  }
}))

test('readLimitedText: returns full text under the limit', async t => {
  t.is(await readLimitedText(streamOf(['hello ', 'world']), 1000), 'hello world')
})

test('readLimitedText: exact boundary is not rejected', async t => {
  t.is(await readLimitedText(streamOf(['abcde']), 5), 'abcde')
})

test('readLimitedText: returns null when the stream exceeds the byte limit', async t => {
  t.is(await readLimitedText(streamOf(['a'.repeat(50)]), 10), null)
})

// buildCurateCandidates

const noProbe = async () => null
// a feed that passes every check: full posts, a few a month, one author, recent
const DAY = 86400000
const goodPosts = (n = 4, { len = 800, every = 10, author = 'me', start = Date.now() - DAY, extra = '' } = {}) =>
  Array.from({ length: n }, (_, i) => ({
    content: `<p>${'word '.repeat(len / 5)}</p>${extra}`,
    date: new Date(start - i * every * DAY).toUTCString(),
    author
  }))
const feedOf = (posts, more = {}) => ({ feedUrl: 'https://found.example.com/feed', posts, ...more })
const feedProbe = async () => feedOf(goodPosts())

const makePost = (links) => ({
  content: links.map(href => `<a href="${href}">link</a>`).join(' ')
})

const makeFreshData = (entries) => new Map(
  entries.map(([url, links]) => [url, { posts: [makePost(links)] }])
)

// Minimal D1 mock supporting what getCandidates/getDismissedDomains/saveCandidates need
const makeDb = ({ candidates: initCandidates = [], dismissed: initDismissed = [], blocked: initBlocked = [] } = {}) => {
  let rows = initCandidates.map(c => ({ ...c }))
  const dismissed = new Set(initDismissed)

  const makeStmt = (sql, args = []) => ({
    bind: (...a) => makeStmt(sql, a),
    all: async () => {
      if (sql.includes('FROM blocked')) {
        return { results: initBlocked.map(d => ({ domain: d })) }
      }
      if (sql.includes('FROM dismissed_domains')) {
        return { results: [...dismissed].map(d => ({ domain: d })) }
      }
      if (sql.includes('FROM curate_candidates')) {
        return {
          results: [...rows].sort((a, b) => a.score - b.score).map(c => ({
            domain: c.domain,
            score: c.score || 0,
            sources: JSON.stringify(c.sources || []),
            first_seen: c.firstSeen || null,
            probed_at: c.probedAt || null,
            feed_url: c.feedUrl || null,
            stats: c.stats ? JSON.stringify(c.stats) : null,
            rejected: c.rejected || null
          }))
        }
      }
      return { results: [] }
    },
    first: async () => null,
    run: async () => {
      if (sql.includes('curate_candidates')) db.writes++
      if (sql.includes('DELETE FROM curate_candidates')) {
        rows = rows.filter(r => r.domain !== args[0])
      } else if (sql.includes('INSERT INTO curate_candidates')) {
        const [domain, score, sourcesJson, firstSeen, probedAt, feedUrl, stats, rejected] = args
        rows.push({ domain, score, sources: JSON.parse(sourcesJson || '[]'), firstSeen, probedAt, feedUrl, stats: stats ? JSON.parse(stats) : null, rejected })
      } else if (sql.includes('UPDATE curate_candidates')) {
        const [score, sourcesJson, firstSeen, probedAt, feedUrl, stats, rejected, domain] = args
        rows = rows.map(r => r.domain === domain ? { domain, score, sources: JSON.parse(sourcesJson || '[]'), firstSeen, probedAt, feedUrl, stats: stats ? JSON.parse(stats) : null, rejected } : r)
      }
    }
  })

  const db = {
    writes: 0,
    prepare: sql => makeStmt(sql),
    batch: async stmts => { for (const s of stmts) await s.run() }
  }
  return db
}

test('buildCurateCandidates: does nothing with empty freshData', async t => {
  const db = makeDb()
  await buildCurateCandidates(db, [], new Map(), noProbe)
  t.is((await getCandidates(db)).length, 0)
})

test('buildCurateCandidates: skips domains already in sourceUrls', async t => {
  const db = makeDb()
  const freshData = makeFreshData([['https://source.com/feed', ['https://known.com/some-post']]])
  await buildCurateCandidates(db, ['https://known.com/feed'], freshData, noProbe)
  const candidates = await getCandidates(db)
  t.falsy(candidates.find(c => c.domain === 'known.com'))
})

test('buildCurateCandidates: skips dismissed domains', async t => {
  const db = makeDb({ dismissed: ['dismissed.com'] })
  const freshData = makeFreshData([['https://source.com/feed', ['https://dismissed.com/post']]])
  await buildCurateCandidates(db, [], freshData, noProbe)
  const candidates = await getCandidates(db)
  t.falsy(candidates.find(c => c.domain === 'dismissed.com'))
})

test('buildCurateCandidates: skips video domains', async t => {
  const db = makeDb()
  const freshData = makeFreshData([['https://source.com/feed', ['https://youtube.com/watch?v=123']]])
  await buildCurateCandidates(db, [], freshData, noProbe)
  const candidates = await getCandidates(db)
  t.falsy(candidates.find(c => c.domain === 'youtube.com'))
})

test('buildCurateCandidates: skips social/noise domains', async t => {
  const db = makeDb()
  const freshData = makeFreshData([['https://source.com/feed', ['https://twitter.com/user', 'https://reddit.com/r/foo']]])
  await buildCurateCandidates(db, [], freshData, noProbe)
  const candidates = await getCandidates(db)
  t.falsy(candidates.find(c => c.domain === 'twitter.com' || c.domain === 'reddit.com'))
})

test('buildCurateCandidates: skips self-links', async t => {
  const db = makeDb()
  const freshData = makeFreshData([['https://source.com/feed', ['https://source.com/other-post']]])
  await buildCurateCandidates(db, [], freshData, noProbe)
  const candidates = await getCandidates(db)
  t.falsy(candidates.find(c => c.domain === 'source.com'))
})

test('buildCurateCandidates: scores by source diversity', async t => {
  const db = makeDb()
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
  const db = makeDb()
  const freshData = makeFreshData([['https://source.com/feed', ['https://newblog.com/post']]])
  await buildCurateCandidates(db, [], freshData, feedProbe)
  const candidates = await getCandidates(db)
  const entry = candidates.find(c => c.domain === 'newblog.com')
  t.ok(entry)
  t.is(entry.feedUrl, 'https://found.example.com/feed')
})

test('buildCurateCandidates: limits new probes per run', async t => {
  const db = makeDb()
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
  const db = makeDb({
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
  const db = makeDb()
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
  const db = makeDb({ candidates: [{ domain: 'late.com', score: 2, sources: [], probedAt: old, feedUrl: null }] })
  const freshData = makeFreshData([
    ['https://a.com/feed', ['https://late.com/post']],
    ['https://b.com/feed', ['https://late.com/post']]
  ])
  await buildCurateCandidates(db, [], freshData, feedProbe)
  const entry = (await getCandidates(db)).find(c => c.domain === 'late.com')
  t.is(entry.feedUrl, 'https://found.example.com/feed')
})

test('saveCandidates: a run that changes nothing writes nothing', async t => {
  const db = makeDb()
  const freshData = makeFreshData([
    ['https://a.com/feed', ['https://quiet.com/post']],
    ['https://b.com/feed', ['https://quiet.com/post']]
  ])
  await buildCurateCandidates(db, [], freshData, feedProbe)
  const before = db.writes
  await buildCurateCandidates(db, [], freshData, feedProbe)
  t.is(db.writes, before)
})

test('buildCurateCandidates: votes add up across scans that never overlap', async t => {
  const db = makeDb()
  await buildCurateCandidates(db, [], makeFreshData([['https://a.com/feed', ['https://quiet.com/post']]]), feedProbe)
  await buildCurateCandidates(db, [], makeFreshData([['https://b.com/feed', ['https://quiet.com/post']]]), feedProbe)
  t.is((await getCandidates(db)).find(c => c.domain === 'quiet.com').score, 2)
})

test('maybeBuildCurateCandidates: runs at most once a day', async t => {
  const state = new Map()
  const base = makeDb()
  const db = {
    ...base,
    prepare: sql => {
      if (sql.includes('settings') || sql.includes('FROM sources')) {
        return {
          bind: (...a) => ({
            first: async () => (sql.includes('SELECT') && state.has(a[0])) ? { value: state.get(a[0]) } : null,
            run: async () => { if (/INSERT|UPDATE/.test(sql)) state.set(a[0], a[1]) },
            all: async () => ({ results: [] })
          })
        }
      }
      return base.prepare(sql)
    }
  }
  const fresh = makeFreshData([['https://a.com/feed', ['https://quiet.com/post']]])
  const now = Date.UTC(2026, 10, 18)
  t.is(await maybeBuildCurateCandidates(db, ['https://a.com/feed', 'https://b.com/feed'], fresh, 'x', feedProbe, now), true)
  t.is(await maybeBuildCurateCandidates(db, [], fresh, 'x', feedProbe, now + 3600000), false)
  t.is(await maybeBuildCurateCandidates(db, [], fresh, 'x', feedProbe, now + 86400000), true)
})

test('buildCurateCandidates: one blog with two curated feeds is one vote', async t => {
  const db = makeDb()
  const freshData = makeFreshData([
    ['https://manu.com/feed', ['https://quiet.com/post']],
    ['https://manu.com/podcast.xml', ['https://quiet.com/post']]
  ])
  await buildCurateCandidates(db, [], freshData, feedProbe)
  t.is((await getCandidates(db)).find(c => c.domain === 'quiet.com').score, 1)
})

test('buildCurateCandidates: blocked domains never become candidates', async t => {
  const db = makeDb({ blocked: ['spam.com'] })
  const freshData = makeFreshData([
    ['https://a.com/feed', ['https://sub.spam.com/post']],
    ['https://b.com/feed', ['https://sub.spam.com/post']]
  ])
  await buildCurateCandidates(db, [], freshData, feedProbe)
  t.is((await getCandidates(db)).length, 0)
})

test('buildCurateCandidates: blocking an existing candidate drops it', async t => {
  const db = makeDb({
    blocked: ['gone.com'],
    candidates: [{ domain: 'gone.com', score: 2, sources: [], feedUrl: 'https://gone.com/feed' }]
  })
  const freshData = makeFreshData([['https://a.com/feed', ['https://other.com/post']]])
  await buildCurateCandidates(db, [], freshData, noProbe)
  t.ok(!(await getCandidates(db)).find(c => c.domain === 'gone.com'))
})

test('buildCurateCandidates: mailto and other non-web links are not votes', async t => {
  const db = makeDb()
  const probed = []
  const freshData = makeFreshData([
    ['https://a.com/feed', ['mailto:me@a.com', 'tel:555', 'https://real.com/post']],
    ['https://b.com/feed', ['mailto:you@b.com', 'https://real.com/post']]
  ])
  await buildCurateCandidates(db, [], freshData, async d => { probed.push(d); return null })
  t.is(probed.join(), 'real.com')
})

test('buildCurateCandidates: platform roots are skipped, blogs on them are not', async t => {
  const db = makeDb()
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
  const db = makeDb({
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
  const db = makeDb()
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
  const db = makeDb()
  const freshData = new Map([
    ['https://feedpress.me/mine', { siteUrl: 'https://mine.blog/', posts: [makePost(['https://other.com/x'])] }],
    ['https://a.com/feed', { posts: [makePost(['https://mine.blog/post'])] }],
    ['https://b.com/feed', { posts: [makePost(['https://mine.blog/post'])] }]
  ])
  await buildCurateCandidates(db, [...freshData.keys()], freshData, feedProbe)
  t.ok(!(await getCandidates(db)).find(c => c.domain === 'mine.blog'))
})

test('blogDomain: site url, then post urls, then the feed itself', t => {
  t.is(blogDomain('https://feeds.feedburner.com/x', { siteUrl: 'https://www.real.blog/' }), 'real.blog')
  t.is(blogDomain('https://feeds.feedburner.com/x', { posts: [{ url: 'https://real.blog/p' }] }), 'real.blog')
  t.is(blogDomain('https://real.blog/feed', {}), 'real.blog')
})

test('buildCurateCandidates: legacy feed-url votes are dropped for blog domains', async t => {
  const db = makeDb({
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
  const db = makeDb()
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
  const db = makeDb()
  const freshData = makeFreshData([['https://a.com/feed', ['https://first.com/1', 'https://second.com/1', 'https://third.com/1']]])
  const probed = []
  await buildCurateCandidates(db, [], freshData, async d => { probed.push(d); return null }, 'x', () => 0)
  t.not(probed[0], 'first.com')
  t.is(probed.length, 3)
})

// the machine's checks

test('feedStats: pace is posts over the span the feed covers', t => {
  // 10 items a day apart - a daily feed even though it only holds 10
  t.ok(feedStats(feedOf(goodPosts(10, { every: 1 })), 'x.com').perMonth > 25)
  t.ok(feedStats(feedOf(goodPosts(4, { every: 10 })), 'x.com').perMonth < 4)
  t.is(feedStats(feedOf(goodPosts(2)), 'x.com').perMonth, null)
})

test('feedStats: authors are counted once, ignoring case and blanks', t => {
  const posts = goodPosts(4)
  posts[0].author = 'Me'; posts[1].author = ''; posts[2].author = 'you'
  t.is(feedStats(feedOf(posts), 'x.com').authors, 2)
})

test('feedStats: link-backs are curated blogs it links to, not itself', t => {
  const extra = '<a href="https://www.friend.blog/p">f</a> <a href="https://x.com/self">s</a> <a href="https://stranger.com/">z</a>'
  const s = feedStats(feedOf(goodPosts(3, { extra })), 'x.com', new Set(['friend.blog', 'x.com']))
  t.deepEqual(s.linksBack, ['friend.blog'])
})

test('feedStats: substack shows up by generator or by domain', t => {
  t.ok(feedStats(feedOf(goodPosts(), { generator: 'Substack' }), 'someone.com').substack)
  t.ok(feedStats(feedOf(goodPosts()), 'someone.substack.com').substack)
  t.falsy(feedStats(feedOf(goodPosts()), 'someone.com').substack)
})

test('rejectReason: a good blog passes', t => {
  t.is(rejectReason(feedStats(feedOf(goodPosts()), 'x.com')), null)
})

test('rejectReason: each hard no has its reason', t => {
  const now = Date.now()
  const stats = (posts, more) => feedStats(feedOf(posts, more), 'x.com')
  t.is(rejectReason(stats([])), 'empty')
  t.is(rejectReason(stats(goodPosts(4, { len: 50 }))), 'truncated')
  t.is(rejectReason(stats(goodPosts(4, { start: now - 200 * DAY }))), 'dead')
  t.is(rejectReason(stats(goodPosts(20, { every: 0.5 }))), 'mag')
  const group = goodPosts(4).map((p, i) => ({ ...p, author: `writer${i}` }))
  t.is(rejectReason(stats(group)), 'group')
  t.is(rejectReason(stats(goodPosts(), { language: 'de-DE' })), 'language')
  t.is(rejectReason(stats(goodPosts(), { language: 'en-US' })), null)
})

test('rejectReason: unknowns pass - no dates is not dead, no bylines is not a group', t => {
  const posts = goodPosts(4).map(p => ({ content: p.content }))
  t.is(rejectReason(feedStats(feedOf(posts), 'x.com')), null)
})

test('statsLine: the why behind a row', t => {
  const extra = '<a href="https://friend.blog/p">f</a>'
  const s = feedStats(feedOf(goodPosts(4, { extra }), { generator: 'Substack' }), 'x.com', new Set(['friend.blog']))
  t.is(statsLine(s), `${s.perMonth} posts/mo · 1 author · full text · links back to 1 · substack`)
  t.is(statsLine(null), '')
})

test('feedInfo: language and generator from the channel, not the items', t => {
  t.deepEqual(feedInfo('<rss><channel><language>en-us</language><generator><![CDATA[Substack]]></generator><item><language>de</language></item>'),
    { language: 'en-us', generator: 'Substack' })
  t.deepEqual(feedInfo('<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="fr"><generator uri="https://gohugo.io/">Hugo</generator><entry>'),
    { language: 'fr', generator: 'Hugo' })
  t.deepEqual(feedInfo('<rss><channel><title>x</title>'), { language: null, generator: null })
})

const twoVotes = domain => makeFreshData([
  ['https://a.com/feed', [`https://${domain}/post`]],
  ['https://b.com/feed', [`https://${domain}/post`]]
])

test('buildCurateCandidates: a machine no is kept with its reason, not dropped', async t => {
  const db = makeDb()
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

  await buildCurateCandidates(makeDb({ candidates: [row(60)] }), [], twoVotes('teaser.com'), probe)
  t.is(probed.length, 0)

  const db = makeDb({ candidates: [row(91)] })
  await buildCurateCandidates(db, [], twoVotes('teaser.com'), probe)
  t.is(probed.join(), 'teaser.com')
  t.is((await getCandidates(db))[0].rejected, null)
})

test('buildCurateCandidates: a row from before the checks gets read once', async t => {
  const probed = []
  const db = makeDb({ candidates: [{ domain: 'old.com', score: 2, sources: ['a.com', 'b.com'], firstSeen: '2026-01-01T00:00:00.000Z', feedUrl: 'https://old.com/feed' }] })
  await buildCurateCandidates(db, [], twoVotes('old.com'), async d => { probed.push(d); return feedOf(goodPosts()) })
  const entry = (await getCandidates(db))[0]
  t.is(probed.join(), 'old.com')
  t.ok(entry.stats)
  t.is(entry.firstSeen, '2026-01-01T00:00:00.000Z')
})

test('buildCurateCandidates: link-backs are counted against discover blogs', async t => {
  const db = makeDb()
  const extra = '<a href="https://a.com/x">a</a>'
  await buildCurateCandidates(db, ['https://a.com/feed', 'https://b.com/feed'], twoVotes('neighbor.com'), async () => feedOf(goodPosts(4, { extra })))
  t.deepEqual((await getCandidates(db))[0].stats.linksBack, ['a.com'])
})

test('buildCurateCandidates: the rebuild button takes a bigger bite', async t => {
  const db = makeDb()
  const domains = Array.from({ length: 12 }, (_, i) => `blog${i}.com`)
  const freshData = makeFreshData([['https://a.com/feed', domains.map(d => `https://${d}/p`)]])
  const res = await buildCurateCandidates(db, [], freshData, feedProbe, 'x', Math.random, { probes: 10 })
  t.is(res.probed, 10)
  t.is(res.passed, 10)
  t.is((await getCandidates(db)).length, 10)
})

test('buildCurateCandidates: nothing is capped away', async t => {
  const db = makeDb()
  const domains = Array.from({ length: 160 }, (_, i) => `blog${i}.com`)
  const freshData = makeFreshData([['https://a.com/feed', domains.map(d => `https://${d}/p`)]])
  await buildCurateCandidates(db, [], freshData, noProbe, 'x', Math.random, { probes: 160 })
  t.is((await getCandidates(db)).length, 160)
})

// dupes

test('sameBlog: www, scheme and feed path do not make a new blog', t => {
  const have = ['https://example.com/feed', 'https://other.blog/rss.xml']
  t.is(sameBlog('http://www.example.com/rss.xml', have), 'https://example.com/feed')
  t.is(sameBlog('https://Example.com/atom.xml', have), 'https://example.com/feed')
  t.is(sameBlog('https://sub.example.com/feed', have), null)
  t.is(sameBlog('not a url', have), null)
})
