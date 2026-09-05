import { parseFeed } from './feedParser.js'
import { makeId, getSourceData, getSourceDataBulk, saveSourceData, updateSourceMeta, getAllSourceUrls, getStaleSourceMeta } from './db-sources.js'
import { getFeeds, saveFeed } from './db-feeds.js'
import { getBlocked, getDismissedDomains, getCandidates, saveCandidates } from './db-moderation.js'
import { getMentions, saveMentions } from './db-mentions.js'
import { getCronState, setCronState } from './db-auth.js'
import { savePostTags } from './db-search.js'
import { listCurators, deleteCurator, isCuratorInactive } from './db-curators.js'

export const VIDEO_DOMAINS = new Set(['youtube.com', 'youtu.be', 'vimeo.com', 'dailymotion.com', 'twitch.tv', 'rumble.com'])

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

const FETCH_HEADERS = { 'User-Agent': 'discover/1.0 (+https://discover.brine.dev; RSS reader)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' }

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

// Manual redirect following — each hop is a counted subrequest on CF free tier.
// Cap at 2 hops (3 total fetches max) so BATCH_SIZE=15 stays under the 50 limit.
export const fetchSource = async (url, limit = 3) => {
  try {
    let currentUrl = url
    for (let hop = 0; hop <= 2; hop++) {
      const res = await fetch(currentUrl, { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: FETCH_HEADERS })
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
      return { posts: parseFeed(xml, { url, limit }), config: { url, limit }, siteUrl: parseSiteUrl(xml), statusCode: res.status }
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

export const fetchAndSaveSource = async (db, url) => {
  const now = Date.now()
  const result = await fetchSource(url, 20)
  let posts = []; let siteUrl = null; let image = null; let frequency = null
  if (result.posts) {
    frequency = computeFrequency(result.posts)
    image = findImage(result.posts) || null
    posts = result.posts.slice(0, 20).map(p => ({ title: p.title, url: p.url, date: p.date, author: p.author, feed: p.feed, content: p.content, tags: p.tags }))
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

export const buildLinkGraph = async (db, sourceUrls, freshData) => {
  if (!freshData.size) return

  const domainToSource = new Map()
  for (const url of sourceUrls) {
    try {
      const host = new URL(url).hostname
      domainToSource.set(host, url)
      const bare = host.replace(/^www\./, '')
      if (bare !== host) domainToSource.set(bare, url)
    } catch {}
  }

  const byTarget = new Map()

  for (const [sourceUrl, data] of freshData) {
    if (!data?.posts?.length) continue
    let fromDomain
    try { fromDomain = new URL(sourceUrl).hostname.replace(/^www\./, '') } catch { continue }
    const fromHash = makeId(sourceUrl)

    for (const post of data.posts) {
      if (!post.content) continue
      const seenInPost = new Set()
      for (const [, href] of post.content.matchAll(/href=["']([^"']+)["']/g)) {
        try {
          const domain = new URL(href).hostname.replace(/^www\./, '')
          if (domain === fromDomain) continue
          if (VIDEO_DOMAINS.has(domain)) continue
          if (!domainToSource.has(domain)) continue
          const dedupeKey = `${fromHash}:${post.url}:${domain}`
          if (seenInPost.has(dedupeKey)) continue
          seenInPost.add(dedupeKey)
          if (!byTarget.has(domain)) byTarget.set(domain, [])
          byTarget.get(domain).push({
            fromSource: sourceUrl,
            fromPost: post.url,
            fromTitle: post.title || '',
            fromDate: post.date || null,
            fromContent: post.content || '',
            toUrl: href,
            foundAt: new Date().toISOString()
          })
        } catch {}
      }
    }
  }

  if (!byTarget.size) return

  await Promise.all([...byTarget.entries()].map(async ([domain, newItems]) => {
    const existing = await getMentions(db, domain)
    const newKeys = new Set(newItems.map(m => `${m.fromSource}:${m.fromPost}`))
    const kept = existing.filter(m => !newKeys.has(`${m.fromSource}:${m.fromPost}`))
    const updated = [...kept, ...newItems]
      .sort((a, b) => new Date(b.foundAt) - new Date(a.foundAt))
      .slice(0, 100)
    await saveMentions(db, domain, updated)
  }))
}

const SKIP_CURATE_DOMAINS = new Set([
  'twitter.com', 'x.com', 't.co', 'facebook.com', 'fb.com', 'instagram.com',
  'linkedin.com', 'reddit.com', 'redd.it', 'tiktok.com', 'pinterest.com',
  'wikipedia.org', 'archive.org', 'web.archive.org',
  'google.com', 'apple.com', 'microsoft.com', 'amazon.com', 'amzn.to',
  'paypal.com', 'stripe.com', 'netlify.app', 'vercel.app', 'github.io',
  'wp.com', 'wordpress.com'
])

const probeFeedUrl = async (domain) => {
  try {
    const res = await fetch(`https://${domain}`, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'discover/1.0 (+https://discover.brine.dev; RSS reader)' } })
    if (res.ok) {
      const html = await res.text()
      const m = html.match(/<link[^>]+type=["']application\/(rss|atom)\+xml["'][^>]+href=["']([^"']+)["']/i) ||
                html.match(/<link[^>]+href=["']([^"']+)["'][^>]+type=["']application\/(rss|atom)\+xml["']/i)
      if (m) {
        const href = m[2] || m[1]
        if (href.startsWith('http')) return href
        return `https://${domain}${href.startsWith('/') ? '' : '/'}${href}`
      }
    }
  } catch {}
  for (const p of ['/feed', '/rss', '/atom.xml', '/feed.xml', '/rss.xml', '/index.xml']) {
    try {
      const res = await fetch(`https://${domain}${p}`, { signal: AbortSignal.timeout(4000), headers: { 'User-Agent': 'discover/1.0 (+https://discover.brine.dev; RSS reader)' } })
      if (!res.ok) continue
      const ct = res.headers.get('content-type') || ''
      if (ct.includes('xml') || ct.includes('rss') || ct.includes('atom')) return `https://${domain}${p}`
    } catch {}
  }
  return null
}

export const buildCurateCandidates = async (db, sourceUrls, freshData, _probe = probeFeedUrl) => {
  if (!freshData.size) return

  const knownDomains = new Set()
  for (const url of sourceUrls) {
    try { knownDomains.add(new URL(url).hostname.replace(/^www\./, '')) } catch {}
  }

  const dismissed = new Set(await getDismissedDomains(db))
  const domainSources = new Map()

  for (const [sourceUrl, data] of freshData) {
    if (!data?.posts?.length) continue
    let fromDomain
    try { fromDomain = new URL(sourceUrl).hostname.replace(/^www\./, '') } catch { continue }
    for (const post of data.posts) {
      if (!post.content) continue
      for (const [, href] of post.content.matchAll(/href=["']([^"']+)["']/g)) {
        try {
          const domain = new URL(href).hostname.replace(/^www\./, '')
          if (domain === fromDomain) continue
          if (VIDEO_DOMAINS.has(domain) || SKIP_CURATE_DOMAINS.has(domain)) continue
          if (knownDomains.has(domain) || dismissed.has(domain)) continue
          if (!domainSources.has(domain)) domainSources.set(domain, new Set())
          domainSources.get(domain).add(sourceUrl)
        } catch {}
      }
    }
  }

  if (!domainSources.size) return

  const scored = [...domainSources.entries()]
    .map(([domain, srcs]) => ({ domain, score: srcs.size, sources: [...srcs] }))
    .sort((a, b) => b.score - a.score)

  const candidates = await getCandidates(db)
  const candidateDomains = new Set(candidates.map(c => c.domain))

  for (const entry of candidates) {
    const srcs = domainSources.get(entry.domain)
    if (srcs) {
      entry.score = Math.max(entry.score, srcs.size)
      entry.sources = [...new Set([...entry.sources, ...srcs])]
    }
  }

  const now = new Date().toISOString()
  const newToProbe = scored.filter(({ domain }) => !candidateDomains.has(domain)).slice(0, 3)

  for (const { domain, score, sources } of newToProbe) {
    const feedUrl = await _probe(domain)
    if (feedUrl) candidates.push({ domain, score, sources, firstSeen: now, probedAt: now, feedUrl })
  }

  candidates.sort((a, b) => b.score - a.score)
  await saveCandidates(db, candidates.slice(0, 50))
}

export const pruneCurators = async (db) => {
  const curators = await listCurators(db)
  const inactive = curators.filter(c => isCuratorInactive(c))
  if (!inactive.length) return { pruned: 0 }
  await Promise.all(inactive.map(c => deleteCurator(db, c.pubkey)))
  return { pruned: inactive.length }
}

const BATCH_SIZE = 24

export const checkDiscoverFeeds = async (env) => {
  const db = env.DISCOVER_DB
  const allFeeds = await getFeeds(db)
  if (!allFeeds?.length) return { processed: 0, skipped: 0 }

  const sourceMetas = await getStaleSourceMeta(db, { limit: BATCH_SIZE })
  const due = sourceMetas.map(m => ({ url: m.url, image: m.image, latestPostUrl: m.latestPostUrl }))

  const freshData = new Map()
  const now = Date.now()

  for (const entry of due) {
    const { url } = entry
    const result = await fetchSource(url, 20)

    if (result.posts) {
      const frequency = computeFrequency(result.posts)
      const image = findImage(result.posts) || entry.image || null
      const posts = result.posts.slice(0, 20).map(p => ({ title: p.title, url: p.url, date: p.date, author: p.author, feed: p.feed, content: p.content, tags: p.tags }))
      const data = { url, siteUrl: result.siteUrl || null, posts, image, frequency, title: posts[0]?.feed?.title || null, statusCode: result.statusCode, error: null, lastFetched: new Date(now).toISOString() }
      await savePostTags(db, url, posts)
      await saveSourceData(db, url, data)
      freshData.set(url, data)
    } else {
      // fetch failed — update metadata only, leave posts untouched
      await updateSourceMeta(db, url, { statusCode: result.statusCode ?? 0, error: result.error || null, lastFetched: new Date(now).toISOString() })
      const existing = await getSourceData(db, url)
      if (existing) freshData.set(url, existing)
    }
  }

  // Recompute feeds that had sources updated OR have never been populated
  const updatedUrls = new Set(due.map(d => d.url))
  const needsUpdate = allFeeds.filter(f =>
    !f.previewPosts?.length ||
    (f.sources || []).some(s => updatedUrls.has(s))
  )

  // Bulk-fetch all source URLs needed for feed recomputation that aren't already in freshData
  const missingUrls = [...new Set(
    needsUpdate.flatMap(f => (f.sources || []).filter(u => !freshData.has(u)))
  )]
  const bulkFetched = await getSourceDataBulk(db, missingUrls)
  const getSource = (url) => freshData.has(url) ? freshData.get(url) : bulkFetched.get(url) || null

  const changedFeeds = []
  for (const feed of needsUpdate) {
    const sourceDatas = (feed.sources || []).map(getSource)
    if (!sourceDatas.filter(Boolean).length) continue
    applySourceDatas(feed, sourceDatas, { keepOnEmpty: true })
    feed.lastUpdated = new Date(now).toISOString()
    changedFeeds.push(feed)
  }
  if (changedFeeds.length) await Promise.all(changedFeeds.map(f => saveFeed(db, f)))

  const allSourceUrls = await getAllSourceUrls(db)
  await buildLinkGraph(db, allSourceUrls, freshData).catch(err => console.error('buildLinkGraph failed:', err))
  await pruneCurators(db).catch(err => console.error('pruneCurators failed:', err))

  await Promise.all([
    setCronState(db, 'cron:lastOk', new Date().toISOString()),
    setCronState(db, 'cron:lastCount', String(due.length))
  ])

  if (env.R2) {
    const today = new Date().toISOString().slice(0, 10)
    const lastBackup = await getCronState(db, 'cron:lastBackup')
    if (lastBackup !== today) {
      const [feeds, blocked] = await Promise.all([getFeeds(db), getBlocked(db)])
      await env.R2.put(`backup/discover-${today}.json`, JSON.stringify({ date: today, feeds: feeds || [], blocked: blocked || [] }), {
        httpMetadata: { contentType: 'application/json' }
      })
      await setCronState(db, 'cron:lastBackup', today)

      // Each snapshot is a full point-in-time copy, not incremental — only
      // the most recent is needed to restore, and a couple weeks of depth
      // covers damage that wasn't noticed immediately. No need to keep more.
      const BACKUP_RETENTION_DAYS = 14
      const cutoff = new Date(today)
      cutoff.setUTCDate(cutoff.getUTCDate() - BACKUP_RETENTION_DAYS)
      const cutoffKey = `backup/discover-${cutoff.toISOString().slice(0, 10)}.json`
      await env.R2.delete(cutoffKey).catch(err => console.error('Backup cleanup failed:', cutoffKey, err))
    }
  }

  return { processed: due.length, skipped: allSourceUrls.length - due.length }
}
