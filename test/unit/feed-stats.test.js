import { unit as test } from '../testpup.js'
import { isFullText, feedStats, rejectReason, statsLine } from '../../worker/feed-stats.js'
import { DAY, goodPosts, feedOf } from '../helpers/feeds.js'

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
