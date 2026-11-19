import { parseFeed } from './feedParser.js'
import { saveSourceData } from './db-sources.js'

// Extract the human site URL from RSS/Atom XML (not the feed URL itself)
const parseSiteUrl = (xml) => {
  // Atom: <link rel="alternate" href="...">
  const atom = xml.match(/<link[^>]+rel=["']alternate["'][^>]+href=["']([^"']+)["']/i) ||
    xml.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']alternate["']/i)
  if (atom?.[1]?.startsWith('http')) return atom[1]
  // RSS 2.0: channel-level <link> — strip <item> blocks first so item links don't match
  const stripped = xml.replace(/<item>[\s\S]*?<\/item>/gi, '')
  const rss = stripped.match(/<link>([^<]+)<\/link>/i)
  const url = rss?.[1]?.trim()
  return url?.startsWith('http') ? url : null
}

// what the feed says about itself: <language> / xml:lang, and <generator>
// (Substack, WordPress...). only the channel part, before the first item
export const feedInfo = (xml) => {
  const head = xml.split(/<(item|entry)[\s>]/i)[0]
  const language = (head.match(/<language>\s*([^<\s]+)\s*<\/language>/i) || head.match(/<feed\b[^>]*xml:lang=["']([^"']+)["']/i))?.[1] || null
  const generator = head.match(/<generator\b[^>]*>([\s\S]*?)<\/generator>/i)?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').trim() || null
  return { language, generator }
}

const stripProcessingInstructions = (xml) => xml.replace(/<\?(?!xml\s)[^?]*\?>/gi, '')

// Each fork should identify itself as its own instance, not as the original.
export const discoverUA = (domain) => domain ? `discover/1.0 (+https://${domain}; RSS reader)` : 'discover/1.0 (RSS reader)'
const fetchHeaders = (domain) => ({ 'User-Agent': discoverUA(domain), Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' })

// Generous for even a large RSS feed, small enough to bound a malicious or
// misbehaving server from making us buffer an unbounded response. Enforced
// by counting streamed bytes rather than trusting Content-Length, which a
// server can omit or lie about.
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024

export const readLimitedText = async (res, maxBytes) => {
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length }
  return new TextDecoder().decode(merged)
}

// Manual redirect following - each hop is a subrequest, and the free plan
// allows 50 a run. 2 hops max, 3 fetches per feed worst case.
export const fetchSource = async (url, limit = 3, domain) => {
  try {
    let currentUrl = url
    const headers = fetchHeaders(domain)
    for (let hop = 0; hop <= 2; hop++) {
      const res = await fetch(currentUrl, { redirect: 'manual', signal: AbortSignal.timeout(10000), headers })
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        if (!loc) return { posts: null, config: { url }, statusCode: res.status }
        currentUrl = loc.startsWith('http') ? loc : new URL(loc, currentUrl).href
        continue
      }
      if (!res.ok) return { posts: null, config: { url }, statusCode: res.status }
      const text = await readLimitedText(res, MAX_RESPONSE_BYTES)
      if (text === null) return { posts: null, config: { url }, statusCode: res.status, error: 'response too large' }
      const xml = stripProcessingInstructions(text)
      return { posts: parseFeed(xml, { url, limit }), config: { url, limit }, siteUrl: parseSiteUrl(xml), ...feedInfo(xml), statusCode: res.status }
    }
    return { posts: null, config: { url }, statusCode: 0, error: 'too many redirects' }
  } catch (err) {
    return { posts: null, config: { url }, statusCode: 0, error: err?.message || String(err) }
  }
}

export const computeFrequency = (posts) => {
  if (!posts?.length) return null
  const now = Date.now()
  const cutoff90 = now - 90 * 24 * 60 * 60 * 1000
  const recent = posts.filter(p => p.date && new Date(p.date).getTime() > cutoff90)
  if (!recent.length) return 'inactive'
  if (recent.length >= 20) return 'daily'
  if (recent.length >= 8) return 'weekly'
  if (recent.length >= 2) return 'monthly'
  return 'inactive'
}

export const findImage = (posts) => {
  for (const p of (posts || [])) {
    const m = p.content?.match(/<img[^>]+src=["']([^"']+)["']/i)
    const src = m?.[1]
    if (src?.startsWith('http')) return src
  }
  return null
}

// what we keep of a post - the parser's extras (enclosures etc) stay behind
export const trimPosts = posts => posts.slice(0, 20).map(p => ({ title: p.title, url: p.url, date: p.date, author: p.author, feed: p.feed, content: p.content, tags: p.tags }))

export const fetchAndSaveSource = async (db, url, domain) => {
  const now = Date.now()
  const result = await fetchSource(url, 20, domain)
  let posts = []; let siteUrl = null; let image = null; let frequency = null
  if (result.posts) {
    frequency = computeFrequency(result.posts)
    image = findImage(result.posts) || null
    posts = trimPosts(result.posts)
    siteUrl = result.siteUrl || null
  }
  const sourceData = { url, siteUrl, posts, image, frequency, title: posts[0]?.feed?.title || null, statusCode: result.statusCode ?? null, error: result.error || null, lastFetched: new Date(now).toISOString() }
  const indexEntry = { url, lastFetched: sourceData.lastFetched, statusCode: sourceData.statusCode, error: sourceData.error, hasPosts: posts.length > 0, latestPostUrl: posts[0]?.url || null, latestPostDate: posts[0]?.date || null, image: sourceData.image, frequency: frequency || null, addedAt: new Date(now).toISOString() }
  await saveSourceData(db, url, sourceData)
  return { sourceData, indexEntry }
}

// Recompute feed metadata from current source data.
// keepOnEmpty: true in cron (transient fetch failures shouldn't wipe existing posts)
export const applySourceDatas = (feed, sourceDatas, { keepOnEmpty = false } = {}) => {
  const valid = sourceDatas.filter(Boolean)
  const allPosts = valid.flatMap(s => s.posts || []).sort((a, b) => new Date(b.date) - new Date(a.date))
  const freshPosts = valid.map(s => s.posts?.[0]).filter(Boolean).sort((a, b) => new Date(b.date) - new Date(a.date))
  feed.previewPosts = keepOnEmpty && !freshPosts.length ? (feed.previewPosts || []) : freshPosts
  feed.coverImage = valid.map(s => s.image).find(Boolean) || feed.coverImage || null
  feed.updateFrequency = computeFrequency(allPosts) ?? feed.updateFrequency ?? null
}
