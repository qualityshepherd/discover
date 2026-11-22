import { bareHost } from './utils.js'

// The machine's half of curation: read a candidate's feed once and say no
// to the obvious ones, so the curate list is only blogs worth a look.
// Every number here is a starting guess - tune, don't trust.

export const FULL_TEXT_MIN_CHARS = 500 // median post length below this reads as excerpts
export const DEAD_DAYS = 180
export const MAG_POSTS_PER_MONTH = 30
export const MAX_AUTHORS = 2

const DAY = 86400000

const postText = p => (p.content || '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&hellip;|&#8230;|&#x2026;/gi, '…')
  .replace(/&raquo;|&rarr;|&#187;|&#8594;/gi, '»')
  .replace(/&nbsp;|&#160;/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim()

// the tail of an excerpt: "Continue reading →", "[…]", a trailing ellipsis
const READ_MORE = /(read more|continue reading|keep reading|read the (full|rest)|\[(…|\.\.\.)\]|…|\.\.\.)\W{0,4}$/i

const median = nums => {
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

// Full text is discover's rule, not a guess: most posts end in "read more",
// or the typical post is too short to be the whole thing. Substack's paid
// posts show up here as teasers, which is the point.
export const isFullText = (posts) => {
  const texts = (posts || []).map(postText).filter(Boolean)
  if (!texts.length) return false
  const teasers = texts.filter(t => READ_MORE.test(t)).length
  if (teasers / texts.length >= 0.5) return false
  return median(texts.map(t => t.length)) >= FULL_TEXT_MIN_CHARS
}

// posts over the span the feed covers, not a fixed window - a daily mag
// whose feed only holds ten items still has to read as daily
const postsPerMonth = (times) => {
  if (times.length < 3) return null
  const span = Math.max((times[0] - times[times.length - 1]) / DAY, 1)
  return Math.round((times.length - 1) / span * 30 * 10) / 10
}

// what the blog is about, by its own tags - the playlist hint
const NOT_A_TOPIC = new Set(['uncategorized', 'uncategorised', 'general', 'misc', 'blog', 'post', 'posts', 'notes', 'note', 'article', 'articles', 'featured'])
export const topTags = (posts, n = 6) => {
  const counts = new Map()
  for (const p of posts || []) for (const t of new Set(p.tags || [])) if (!NOT_A_TOPIC.has(t)) counts.set(t, (counts.get(t) || 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([t]) => t)
}

// feed: { feedUrl, posts, siteUrl, language, generator }
// known: domains already in discover, for link-backs
export const feedStats = (feed, domain, known = new Set()) => {
  const posts = feed?.posts || []
  const times = posts.map(p => Date.parse(p.date)).filter(Number.isFinite).sort((a, b) => b - a)
  const self = new Set([domain, bareHost(feed?.siteUrl), bareHost(feed?.feedUrl)].filter(Boolean))
  const linksBack = new Set()
  for (const p of posts) {
    for (const [, href] of (p.content || '').matchAll(/href=["']([^"']+)["']/g)) {
      const d = bareHost(href)
      if (d && !self.has(d) && known.has(d)) linksBack.add(d)
    }
  }
  const generator = feed?.generator || null
  return {
    topTags: topTags(posts),
    posts: posts.length,
    perMonth: postsPerMonth(times),
    authors: new Set(posts.map(p => (p.author || '').trim().toLowerCase()).filter(Boolean)).size,
    fullText: isFullText(posts),
    lastPost: times.length ? new Date(times[0]).toISOString() : null,
    language: feed?.language || null,
    generator,
    substack: /substack/i.test(generator || '') || /\.substack\.com$/.test(domain || ''),
    linksBack: [...linksBack].sort()
  }
}

// the hard-no checks, cheapest-to-be-sure first. null means it passed.
// unknowns pass: no dates isn't dead, no bylines isn't a group.
export const rejectReason = (stats, now = Date.now()) => {
  if (!stats.posts) return 'empty'
  if (!stats.fullText) return 'truncated'
  if (stats.lastPost && now - Date.parse(stats.lastPost) > DEAD_DAYS * DAY) return 'dead'
  if (stats.perMonth != null && stats.perMonth > MAG_POSTS_PER_MONTH) return 'mag'
  if (stats.authors > MAX_AUTHORS) return 'group'
  if (stats.language && !/^en\b/i.test(stats.language)) return 'language'
  return null
}

// "3 posts/mo · 1 author · links back to 2 · substack" - the why behind a row
export const statsLine = (s) => {
  if (!s) return ''
  const bits = []
  if (s.perMonth != null) bits.push(`${s.perMonth} posts/mo`)
  if (s.authors) bits.push(`${s.authors} author${s.authors === 1 ? '' : 's'}`)
  bits.push(s.fullText ? 'full text' : 'excerpts')
  if (s.linksBack?.length) bits.push(`links back to ${s.linksBack.length}`)
  if (s.language) bits.push(s.language)
  if (s.substack) bits.push('substack')
  return bits.join(' · ')
}
