import { unit as test } from '../testpup.js'
import { computeFrequency, makeId, computeTags, isClickThrough } from '../../worker/discover.js'
import { buildCurateCandidates } from '../../worker/discover-cron.js'
import {
  isBlocked,
  isCuratorOf, shouldUpdateLastSeen, isCuratorInactive,
  getCandidates
} from '../../worker/discover-db.js'

// ── isBlocked ─────────────────────────────────────────────────────────────────

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

// ── makeId ────────────────────────────────────────────────────────────────────

test('makeId: same url returns same id', t => {
  t.is(makeId('https://example.com/feed.xml'), makeId('https://example.com/feed.xml'))
})

test('makeId: different urls return different ids', t => {
  t.not(makeId('https://example.com/feed.xml'), makeId('https://other.com/feed.xml'))
})

test('makeId: returns non-empty string', t => {
  t.ok(makeId('https://example.com').length > 0)
})

// ── computeTags ───────────────────────────────────────────────────────────────

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

// ── computeFrequency ──────────────────────────────────────────────────────────

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

// ── isCuratorOf ───────────────────────────────────────────────────────────────

test('isCuratorOf: true when playlistId matches', t => {
  t.ok(isCuratorOf({ playlistId: 'abc' }, 'abc'))
})

test('isCuratorOf: false when playlistId differs', t => {
  t.falsy(isCuratorOf({ playlistId: 'abc' }, 'xyz'))
})

test('isCuratorOf: false for null curator', t => {
  t.falsy(isCuratorOf(null, 'abc'))
})

// ── shouldUpdateLastSeen ──────────────────────────────────────────────────────

test('shouldUpdateLastSeen: true when lastSeen never set', t => {
  t.ok(shouldUpdateLastSeen({}))
})

test('shouldUpdateLastSeen: true when lastSeen > 24hrs ago', t => {
  const ts = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
  t.ok(shouldUpdateLastSeen({ lastSeen: ts }))
})

test('shouldUpdateLastSeen: false when lastSeen < 24hrs ago', t => {
  const ts = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString()
  t.falsy(shouldUpdateLastSeen({ lastSeen: ts }))
})

// ── isCuratorInactive ─────────────────────────────────────────────────────────

test('isCuratorInactive: true when lastSeen > 180 days ago', t => {
  const ts = new Date(Date.now() - 181 * 24 * 60 * 60 * 1000).toISOString()
  t.ok(isCuratorInactive({ lastSeen: ts }))
})

test('isCuratorInactive: false when lastSeen recent', t => {
  const ts = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  t.falsy(isCuratorInactive({ lastSeen: ts }))
})

test('isCuratorInactive: false when no lastSeen', t => {
  t.falsy(isCuratorInactive({}))
})

// ── isClickThrough ────────────────────────────────────────────────────────────

test('isClickThrough: false for empty/null posts', t => {
  t.falsy(isClickThrough([]))
  t.falsy(isClickThrough(null))
})

test('isClickThrough: false when at least one post has real content', t => {
  const posts = [
    { content: '<p>' + 'x'.repeat(150) + '</p>' },
    { content: '' }
  ]
  t.falsy(isClickThrough(posts))
})

test('isClickThrough: true when all posts have no meaningful content', t => {
  const posts = [
    { content: '<p>Read more</p>' },
    { content: '' },
    { content: '<a href="http://x.com">click</a>' }
  ]
  t.ok(isClickThrough(posts))
})

test('isClickThrough: true when content strips to fewer than 100 chars across all posts', t => {
  const posts = Array.from({ length: 5 }, () => ({ content: '<p>short</p>' }))
  t.ok(isClickThrough(posts))
})

test('isClickThrough: false when one post has >100 chars of text', t => {
  const longText = 'a'.repeat(101)
  const posts = [{ content: `<p>${longText}</p>` }, { content: '' }]
  t.falsy(isClickThrough(posts))
})

// ── buildCurateCandidates ─────────────────────────────────────────────────────

const noProbe = async () => null
const feedProbe = async () => 'https://found.example.com/feed'

const makeSourceIndex = (urls) => Object.fromEntries(
  urls.map(url => [makeId(url), { url }])
)

const makePost = (links) => ({
  content: links.map(href => `<a href="${href}">link</a>`).join(' ')
})

const makeFreshData = (entries) => new Map(
  entries.map(([url, links]) => [url, { posts: [makePost(links)] }])
)

// Minimal D1 mock supporting what getCandidates/getDismissedDomains/saveCandidates need
const makeDb = ({ candidates: initCandidates = [], dismissed: initDismissed = [] } = {}) => {
  let rows = initCandidates.map(c => ({ ...c }))
  const dismissed = new Set(initDismissed)

  const makeStmt = (sql, args = []) => ({
    bind: (...a) => makeStmt(sql, a),
    all: async () => {
      if (sql.includes('FROM dismissed_domains')) {
        return { results: [...dismissed].map(d => ({ domain: d })) }
      }
      if (sql.includes('FROM curate_candidates')) {
        return {
          results: [...rows].sort((a, b) => b.score - a.score).map(c => ({
            domain: c.domain,
            score: c.score || 0,
            sources: JSON.stringify(c.sources || []),
            first_seen: c.firstSeen || null,
            probed_at: c.probedAt || null,
            feed_url: c.feedUrl || null
          }))
        }
      }
      return { results: [] }
    },
    first: async () => null,
    run: async () => {
      if (sql.includes('DELETE FROM curate_candidates')) { rows = [] } else if (sql.includes('INSERT INTO curate_candidates')) {
        const [domain, score, sourcesJson, firstSeen, probedAt, feedUrl] = args
        rows.push({ domain, score, sources: JSON.parse(sourcesJson || '[]'), firstSeen, probedAt, feedUrl })
      }
    }
  })

  return {
    prepare: sql => makeStmt(sql),
    batch: async stmts => { for (const s of stmts) await s.run() }
  }
}

test('buildCurateCandidates: does nothing with empty freshData', async t => {
  const db = makeDb()
  await buildCurateCandidates(db, {}, new Map(), noProbe)
  t.is((await getCandidates(db)).length, 0)
})

test('buildCurateCandidates: skips domains already in sourceIndex', async t => {
  const db = makeDb()
  const sourceIndex = makeSourceIndex(['https://known.com/feed'])
  const freshData = makeFreshData([['https://source.com/feed', ['https://known.com/some-post']]])
  await buildCurateCandidates(db, sourceIndex, freshData, noProbe)
  const candidates = await getCandidates(db)
  t.falsy(candidates.find(c => c.domain === 'known.com'))
})

test('buildCurateCandidates: skips dismissed domains', async t => {
  const db = makeDb({ dismissed: ['dismissed.com'] })
  const freshData = makeFreshData([['https://source.com/feed', ['https://dismissed.com/post']]])
  await buildCurateCandidates(db, {}, freshData, noProbe)
  const candidates = await getCandidates(db)
  t.falsy(candidates.find(c => c.domain === 'dismissed.com'))
})

test('buildCurateCandidates: skips video domains', async t => {
  const db = makeDb()
  const freshData = makeFreshData([['https://source.com/feed', ['https://youtube.com/watch?v=123']]])
  await buildCurateCandidates(db, {}, freshData, noProbe)
  const candidates = await getCandidates(db)
  t.falsy(candidates.find(c => c.domain === 'youtube.com'))
})

test('buildCurateCandidates: skips social/noise domains', async t => {
  const db = makeDb()
  const freshData = makeFreshData([['https://source.com/feed', ['https://twitter.com/user', 'https://reddit.com/r/foo']]])
  await buildCurateCandidates(db, {}, freshData, noProbe)
  const candidates = await getCandidates(db)
  t.falsy(candidates.find(c => c.domain === 'twitter.com' || c.domain === 'reddit.com'))
})

test('buildCurateCandidates: skips self-links', async t => {
  const db = makeDb()
  const freshData = makeFreshData([['https://source.com/feed', ['https://source.com/other-post']]])
  await buildCurateCandidates(db, {}, freshData, noProbe)
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
  await buildCurateCandidates(db, {}, freshData, feedProbe)
  const candidates = await getCandidates(db)
  const entry = candidates.find(c => c.domain === 'target.com')
  t.ok(entry)
  t.is(entry.score, 3)
  t.is(entry.sources.length, 3)
})

test('buildCurateCandidates: probe returning feed url goes to candidates', async t => {
  const db = makeDb()
  const freshData = makeFreshData([['https://source.com/feed', ['https://newblog.com/post']]])
  await buildCurateCandidates(db, {}, freshData, feedProbe)
  const candidates = await getCandidates(db)
  const entry = candidates.find(c => c.domain === 'newblog.com')
  t.ok(entry)
  t.is(entry.feedUrl, 'https://found.example.com/feed')
})

test('buildCurateCandidates: limits new probes to 3', async t => {
  const db = makeDb()
  const domains = ['alpha.com', 'beta.com', 'gamma.com', 'delta.com', 'epsilon.com']
  const freshData = makeFreshData(
    domains.flatMap(d => [
      [`https://src1-${d}/feed`, [`https://${d}/post`]],
      [`https://src2-${d}/feed`, [`https://${d}/other`]]
    ])
  )
  await buildCurateCandidates(db, {}, freshData, feedProbe)
  const candidates = await getCandidates(db)
  t.is(candidates.length, 3)
})

test('buildCurateCandidates: updates score for existing candidate', async t => {
  const db = makeDb({
    candidates: [{ domain: 'known.com', feedUrl: 'https://known.com/feed', score: 1, sources: ['https://old.com/feed'] }]
  })
  const freshData = makeFreshData([
    ['https://new1.com/feed', ['https://known.com/post']],
    ['https://new2.com/feed', ['https://known.com/post']]
  ])
  await buildCurateCandidates(db, {}, freshData, noProbe)
  const candidates = await getCandidates(db)
  const entry = candidates.find(c => c.domain === 'known.com')
  t.ok(entry)
  t.is(entry.score, 2)
})
