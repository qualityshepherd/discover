import { unit as test } from '../testpup.js'
import { handleNew } from '../../worker/discover.js'

// handleNew does one query (getNewestSourcePosts) then paginates in JS -
// mock just that query's row shape.
const mockDb = (rows) => ({ prepare: () => ({ all: async () => ({ results: rows }) }) })

const iso = (daysAgo, hhmmss = '00:00:00') => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - daysAgo)
  return d.toISOString().slice(0, 10) + `T${hhmmss}Z`
}

const sourceRow = (url, feedId, posts) => ({
  url, posts: JSON.stringify(posts), feed_id: feedId, feed_title: `Feed ${feedId}`, playlist_id: feedId, playlist_slug: `feed-${feedId}`
})

const req = (qs = '') => new Request(`https://discover.brine.dev/api/discover/new${qs}`)

test('handleNew: returns the first page sorted newest-first', async t => {
  const db = mockDb([
    sourceRow('https://a.com', 'p1', [{ url: 'https://a.com/1', date: iso(1) }]),
    sourceRow('https://b.com', 'p2', [{ url: 'https://b.com/1', date: iso(0) }])
  ])
  const res = await handleNew(db, new URL(req('?limit=20').url))
  const body = await res.json()
  t.is(body.posts.length, 2)
  t.is(body.posts[0].url, 'https://b.com/1') // newer first
  t.is(body.posts[1].url, 'https://a.com/1')
})

test('handleNew: paginates - limit caps the page and returns a cursor', async t => {
  const db = mockDb([
    sourceRow('https://a.com', 'p1', [
      { url: 'https://a.com/1', date: iso(0) },
      { url: 'https://a.com/2', date: iso(1) },
      { url: 'https://a.com/3', date: iso(2) }
    ])
  ])
  const res = await handleNew(db, new URL(req('?limit=2').url))
  const body = await res.json()
  t.is(body.posts.length, 2)
  t.ok(body.nextCursor)

  const res2 = await handleNew(db, new URL(req(`?limit=2&before=${encodeURIComponent(body.nextCursor)}`).url))
  const body2 = await res2.json()
  t.is(body2.posts.length, 1)
  t.is(body2.posts[0].url, 'https://a.com/3')
  t.is(body2.nextCursor, null) // last page, fewer than limit
})

test('handleNew: no posts left after the last page means no cursor and nothing missing', async t => {
  const db = mockDb([
    sourceRow('https://a.com', 'p1', [{ url: 'https://a.com/1', date: iso(0) }])
  ])
  const res = await handleNew(db, new URL(req('?limit=20').url))
  const body = await res.json()
  t.is(body.nextCursor, null)
})

test('handleNew: posts sharing the exact same date (cron batch) are not skipped or repeated across the page boundary', async t => {
  const sameDate = iso(0)
  const db = mockDb([
    sourceRow('https://a.com', 'p1', [
      { url: 'https://a.com/1', date: sameDate },
      { url: 'https://a.com/2', date: sameDate },
      { url: 'https://a.com/3', date: sameDate }
    ])
  ])
  const res = await handleNew(db, new URL(req('?limit=2').url))
  const body = await res.json()
  t.is(body.posts.length, 2)
  t.ok(body.nextCursor)

  const res2 = await handleNew(db, new URL(req(`?limit=2&before=${encodeURIComponent(body.nextCursor)}`).url))
  const body2 = await res2.json()
  const allUrls = [...body.posts, ...body2.posts].map(p => p.url).sort()
  t.deepEqual(allUrls, ['https://a.com/1', 'https://a.com/2', 'https://a.com/3'])
})

test('handleNew: posts older than 30 days are excluded', async t => {
  const db = mockDb([
    sourceRow('https://a.com', 'p1', [
      { url: 'https://a.com/old', date: iso(40) },
      { url: 'https://a.com/new', date: iso(1) }
    ])
  ])
  const res = await handleNew(db, new URL(req('?limit=20').url))
  const body = await res.json()
  t.is(body.posts.length, 1)
  t.is(body.posts[0].url, 'https://a.com/new')
})
