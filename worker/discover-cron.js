import { parseFeed } from './feedParser.js'
import {
  makeId, getFeeds, getSourceIndex, getSourceData, saveSourceData, saveFeed,
  KV_SOURCE_INDEX,
  listCurators, deleteCurator, isCuratorInactive
} from './discover-kv.js'

const STALE_MS = 4 * 60 * 60 * 1000
const MAX_FETCHES_PER_RUN = 20

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

const stripProcessingInstructions = (xml) => xml.replace(/<\?(?!xml\s)[^?]*\?>/gi, '')

export const fetchSource = async (url, limit = 3) => {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'discover/1.0 (+https://discover.brine.dev; RSS reader)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' } })
    if (!res.ok) return { posts: null, config: { url }, statusCode: res.status }
    const xml = stripProcessingInstructions(await res.text())
    return { posts: parseFeed(xml, { url, title: '', limit }), config: { url, limit }, siteUrl: parseSiteUrl(xml), statusCode: res.status }
  } catch (err) {
    return { posts: null, config: { url }, statusCode: 0, error: err?.message || String(err) }
  }
}

export const computeFrequency = (posts) => {
  if (!posts?.length) return null
  const now = Date.now()
  const cutoff90 = now - 90 * 24 * 60 * 60 * 1000
  const recent = posts.filter(p => p.date && new Date(p.date).getTime() > cutoff90)
  if (!recent.length) return null
  if (recent.length >= 20) return 'daily'
  if (recent.length >= 8) return 'weekly'
  if (recent.length >= 2) return 'monthly'
  return null
}

const findImage = (posts) => {
  for (const p of (posts || [])) {
    const m = p.content?.match(/<img[^>]+src=["']([^"']+)["']/i)
    const src = m?.[1]
    if (src?.startsWith('http')) return src
  }
  return null
}

// Cron + admin: fetch stale sources oldest-first, update source KVs,
// recompute coverImage / updateFrequency / previewPosts on affected feeds.
// Fetch a source URL, save to KV, return { sourceData, indexEntry }.
// Used by admin add/edit — no existing-data fallback since source is new.
export const fetchAndSaveSource = async (kv, url) => {
  const now = Date.now()
  const result = await fetchSource(url, 10)
  let posts = []; let siteUrl = null; let image = null
  if (result.posts) {
    posts = result.posts.slice(0, 10).map(p => ({ title: p.title, url: p.url, date: p.date, author: p.author, feed: p.feed, content: p.content }))
    siteUrl = result.siteUrl || null
    image = findImage(posts) || null
  }
  const sourceData = { url, siteUrl, posts, image, statusCode: result.statusCode ?? null, error: result.error || null, lastFetched: new Date(now).toISOString() }
  const indexEntry = { url, lastFetched: sourceData.lastFetched, statusCode: sourceData.statusCode, error: sourceData.error, hasPosts: posts.length > 0, latestPostUrl: posts[0]?.url || null, image: sourceData.image, addedAt: new Date(now).toISOString() }
  await saveSourceData(kv, url, sourceData)
  return { sourceData, indexEntry }
}

// Recompute feed metadata from current source data.
// keepOnEmpty: true in cron (transient fetch failures shouldn't wipe existing posts)
export const applySourceDatas = (feed, sourceDatas, { keepOnEmpty = false } = {}) => {
  const valid = sourceDatas.filter(Boolean)
  const allPosts = valid.flatMap(s => s.posts || []).sort((a, b) => new Date(b.date) - new Date(a.date))
  const freshPosts = valid.map(s => s.posts?.[0]).filter(Boolean)
  feed.previewPosts = keepOnEmpty && !freshPosts.length ? (feed.previewPosts || []) : freshPosts
  feed.coverImage = valid.map(s => s.image).find(Boolean) || feed.coverImage || null
  feed.updateFrequency = computeFrequency(allPosts) ?? feed.updateFrequency ?? null
}

export const pruneCurators = async (kv) => {
  const curators = await listCurators(kv)
  const inactive = curators.filter(c => isCuratorInactive(c))
  if (!inactive.length) return { pruned: 0 }
  await Promise.all(inactive.map(c => deleteCurator(kv, c.pubkey)))
  return { pruned: inactive.length }
}

export const checkDiscoverFeeds = async (env, { force = false } = {}) => {
  const kv = env.DISCOVER_KV
  const allFeeds = await getFeeds(kv)
  if (!allFeeds?.length) return { processed: 0, skipped: 0 }

  const now = Date.now()
  const sourceIndex = await getSourceIndex(kv)
  const allSourceUrls = [...new Set(allFeeds.flatMap(f => f.sources || []))]

  const due = allSourceUrls
    .map(url => ({ url, t: sourceIndex[makeId(url)]?.lastFetched ? new Date(sourceIndex[makeId(url)].lastFetched).getTime() : 0 }))
    .filter(({ t }) => force || now - t >= STALE_MS)
    .sort((a, b) => a.t - b.t)
    .slice(0, MAX_FETCHES_PER_RUN)

  const freshData = new Map()

  for (const { url } of due) {
    const hash = makeId(url)
    const entry = sourceIndex[hash] || {}
    const result = await fetchSource(url, 10)

    if (result.posts) {
      const posts = result.posts.slice(0, 10).map(p => ({ title: p.title, url: p.url, date: p.date, author: p.author, feed: p.feed, content: p.content }))
      const latestPostUrl = posts[0]?.url || null
      const image = findImage(posts) || entry.image || null
      const changed = latestPostUrl !== entry.latestPostUrl || image !== entry.image

      if (changed) {
        const data = { url, siteUrl: result.siteUrl || null, posts, image, statusCode: result.statusCode, error: null, lastFetched: new Date(now).toISOString() }
        await saveSourceData(kv, url, data)
        freshData.set(url, data)
      }
      sourceIndex[hash] = { ...entry, url, lastFetched: new Date(now).toISOString(), statusCode: result.statusCode, error: null, hasPosts: posts.length > 0, latestPostUrl, image, addedAt: entry.addedAt || new Date(now).toISOString() }
    } else {
      // fetch failed — update index only, leave sourceData untouched
      sourceIndex[hash] = { ...entry, url, lastFetched: new Date(now).toISOString(), statusCode: result.statusCode ?? 0, error: result.error || null, addedAt: entry.addedAt || new Date(now).toISOString() }
      const existing = await getSourceData(kv, url)
      if (existing) freshData.set(url, existing)
    }
  }

  if (due.length) await kv.put(KV_SOURCE_INDEX, JSON.stringify(sourceIndex))

  // Recompute feeds that had sources updated OR have never been populated
  const updatedUrls = new Set(due.map(d => d.url))
  const needsUpdate = allFeeds.filter(f =>
    !f.previewPosts?.length ||
    (f.sources || []).some(s => updatedUrls.has(s))
  )

  for (const feed of needsUpdate) {
    const sourceDatas = await Promise.all(
      (feed.sources || []).map(url => freshData.has(url) ? freshData.get(url) : getSourceData(kv, url))
    )
    if (!sourceDatas.filter(Boolean).length) continue
    applySourceDatas(feed, sourceDatas, { keepOnEmpty: true })
    feed.lastUpdated = new Date(now).toISOString()
    await saveFeed(kv, feed)
  }

  await pruneCurators(kv).catch(err => console.error('pruneCurators failed:', err))

  return { processed: due.length, skipped: allSourceUrls.length - due.length }
}
