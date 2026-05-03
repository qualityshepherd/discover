import { parseFeed } from './feedParser.js'
import {
  makeId, getFeeds, getSourceIndex, getSourceData, saveSourceData, saveFeeds,
  KV_SOURCE_INDEX, getBlocked,
  listCurators, deleteCurator, isCuratorInactive
} from './discover-kv.js'

export const VIDEO_DOMAINS = new Set(['youtube.com', 'youtu.be', 'vimeo.com', 'dailymotion.com', 'twitch.tv', 'rumble.com'])

const MAX_FETCHES_PER_RUN = 20

const staleMsFor = (freq) => {
  if (freq === 'daily') return 8 * 60 * 60 * 1000
  if (freq === 'weekly') return 12 * 60 * 60 * 1000
  if (freq === 'monthly') return 24 * 60 * 60 * 1000
  if (freq === 'inactive') return 48 * 60 * 60 * 1000
  return 12 * 60 * 60 * 1000 // unknown — treat as weekly until frequency is established
}

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
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'discover/1.0 (+https://discover.brine.dev; RSS reader)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' } })
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

// Cron + admin: fetch stale sources oldest-first, update source KVs,
// recompute coverImage / updateFrequency / previewPosts on affected feeds.
// Fetch a source URL, save to KV, return { sourceData, indexEntry }.
// Used by admin add/edit — no existing-data fallback since source is new.
export const fetchAndSaveSource = async (kv, url) => {
  const now = Date.now()
  const result = await fetchSource(url, 10)
  let posts = []; let siteUrl = null; let image = null; let frequency = null
  if (result.posts) {
    frequency = computeFrequency(result.posts)
    image = findImage(result.posts) || null
    posts = result.posts.slice(0, 3).map(p => ({ title: p.title, url: p.url, date: p.date, author: p.author, feed: p.feed, content: p.content }))
    siteUrl = result.siteUrl || null
  }
  const sourceData = { url, siteUrl, posts, image, statusCode: result.statusCode ?? null, error: result.error || null, lastFetched: new Date(now).toISOString() }
  const indexEntry = { url, lastFetched: sourceData.lastFetched, statusCode: sourceData.statusCode, error: sourceData.error, hasPosts: posts.length > 0, latestPostUrl: posts[0]?.url || null, latestPostDate: posts[0]?.date || null, image: sourceData.image, frequency: frequency || null, addedAt: new Date(now).toISOString() }
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

export const buildLinkGraph = async (kv, sourceIndex, freshData) => {
  if (!freshData.size) return

  const domainToSource = new Map()
  for (const entry of Object.values(sourceIndex)) {
    try {
      const host = new URL(entry.url).hostname
      domainToSource.set(host, entry.url)
      const bare = host.replace(/^www\./, '')
      if (bare !== host) domainToSource.set(bare, entry.url)
    } catch {}
  }

  const byTarget = new Map() // targetHash → mention[]

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
          if (domain === fromDomain) continue // skip self-links
          if (VIDEO_DOMAINS.has(domain)) continue // skip youtube
          const targetUrl = domainToSource.get(domain)
          if (!targetUrl) continue // only include discover sources
          const targetHash = makeId(targetUrl)
          if (targetHash === fromHash) continue
          const dedupeKey = `${fromHash}:${post.url}:${targetHash}`
          if (seenInPost.has(dedupeKey)) continue
          seenInPost.add(dedupeKey)
          if (!byTarget.has(targetHash)) byTarget.set(targetHash, [])
          byTarget.get(targetHash).push({
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

  let indexDirty = false
  await Promise.all([...byTarget.entries()].map(async ([targetHash, newItems]) => {
    const existing = await kv.get(`mentions:${targetHash}`, { type: 'json' }) || []
    const newKeys = new Set(newItems.map(m => `${m.fromSource}:${m.fromPost}`))
    const kept = existing.filter(m => !newKeys.has(`${m.fromSource}:${m.fromPost}`))
    const updated = [...kept, ...newItems]
      .sort((a, b) => new Date(b.foundAt) - new Date(a.foundAt))
      .slice(0, 100)
    await kv.put(`mentions:${targetHash}`, JSON.stringify(updated))
    if (sourceIndex[targetHash]) {
      sourceIndex[targetHash].mentionCount = updated.length
      indexDirty = true
    }
  }))

  if (indexDirty) await kv.put(KV_SOURCE_INDEX, JSON.stringify(sourceIndex))
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

export const buildCurateCandidates = async (kv, sourceIndex, freshData, _probe = probeFeedUrl) => {
  if (!freshData.size) return

  const knownDomains = new Set()
  for (const entry of Object.values(sourceIndex)) {
    try {
      const h = new URL(entry.url).hostname.replace(/^www\./, '')
      knownDomains.add(h)
    } catch {}
  }

  const dismissed = new Set(await kv.get('discover:dismissed-domains', { type: 'json' }) || [])
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

  const [existingCandidates, existingTrending] = await Promise.all([
    kv.get('discover:curate-candidates', { type: 'json' }),
    kv.get('discover:trending-domains', { type: 'json' })
  ])
  const candidates = existingCandidates || []
  const trending = existingTrending || []
  const candidateDomains = new Set(candidates.map(c => c.domain))
  const trendingDomains = new Set(trending.map(t => t.domain))

  for (const entry of [...candidates, ...trending]) {
    const srcs = domainSources.get(entry.domain)
    if (srcs) {
      entry.score = Math.max(entry.score, srcs.size)
      entry.sources = [...new Set([...entry.sources, ...srcs])]
    }
  }

  const now = new Date().toISOString()
  const newToProbe = scored.filter(({ domain }) => !candidateDomains.has(domain) && !trendingDomains.has(domain)).slice(0, 3)

  for (const { domain, score, sources } of newToProbe) {
    const feedUrl = await _probe(domain)
    const entry = { domain, score, sources, firstSeen: now, probedAt: now }
    if (feedUrl) candidates.push({ ...entry, feedUrl })
    else trending.push(entry)
  }

  candidates.sort((a, b) => b.score - a.score)
  trending.sort((a, b) => b.score - a.score)

  await Promise.all([
    kv.put('discover:curate-candidates', JSON.stringify(candidates.slice(0, 50))),
    kv.put('discover:trending-domains', JSON.stringify(trending.filter(t => t.score >= 2).slice(0, 50)))
  ])
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
    .map(url => {
      const entry = sourceIndex[makeId(url)] || {}
      const t = entry.lastFetched ? new Date(entry.lastFetched).getTime() : 0
      return { url, t, staleMs: staleMsFor(entry.frequency) }
    })
    .filter(({ t, staleMs }) => force || now - t >= staleMs)
    .sort((a, b) => a.t - b.t)
    .slice(0, MAX_FETCHES_PER_RUN)

  const freshData = new Map()

  for (const { url } of due) {
    const hash = makeId(url)
    const entry = sourceIndex[hash] || {}
    const result = await fetchSource(url, 10)

    if (result.posts) {
      const frequency = computeFrequency(result.posts)
      const image = findImage(result.posts) || entry.image || null
      const posts = result.posts.slice(0, 3).map(p => ({ title: p.title, url: p.url, date: p.date, author: p.author, feed: p.feed, content: p.content }))
      const latestPostUrl = posts[0]?.url || null
      const changed = latestPostUrl !== entry.latestPostUrl || image !== entry.image

      const data = { url, siteUrl: result.siteUrl || null, posts, image, statusCode: result.statusCode, error: null, lastFetched: new Date(now).toISOString() }
      if (changed) {
        await saveSourceData(kv, url, data)
        freshData.set(url, data)
      }
      sourceIndex[hash] = { ...entry, url, lastFetched: new Date(now).toISOString(), statusCode: result.statusCode, error: null, hasPosts: posts.length > 0, latestPostUrl, latestPostDate: posts[0]?.date || entry.latestPostDate || null, image, frequency: frequency || entry.frequency || null, addedAt: entry.addedAt || new Date(now).toISOString() }
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

  const changedFeeds = []
  for (const feed of needsUpdate) {
    const sourceDatas = await Promise.all(
      (feed.sources || []).map(url => freshData.has(url) ? freshData.get(url) : getSourceData(kv, url))
    )
    if (!sourceDatas.filter(Boolean).length) continue
    applySourceDatas(feed, sourceDatas, { keepOnEmpty: true })
    feed.lastUpdated = new Date(now).toISOString()
    changedFeeds.push(feed)
  }
  if (changedFeeds.length) await saveFeeds(kv, allFeeds, changedFeeds)

  await buildLinkGraph(kv, sourceIndex, freshData).catch(err => console.error('buildLinkGraph failed:', err))
  await buildCurateCandidates(kv, sourceIndex, freshData).catch(err => console.error('buildCurateCandidates failed:', err))
  await pruneCurators(kv).catch(err => console.error('pruneCurators failed:', err))

  if (freshData.size) {
    const sourceAll = await kv.get('source:all', { type: 'json' }) || {}
    for (const [url, data] of freshData) {
      sourceAll[makeId(url)] = { url: data.url, posts: data.posts, image: data.image, siteUrl: data.siteUrl }
    }
    await kv.put('source:all', JSON.stringify(sourceAll))
  }

  await kv.put('cron:lastOk', new Date().toISOString())

  if (env.R2) {
    const today = new Date().toISOString().slice(0, 10)
    const key = `backup/discover-${today}.json`
    const existing = await env.R2.head(key).catch(() => null)
    if (!existing) {
      const [feeds, blocked] = await Promise.all([getFeeds(kv), getBlocked(kv)])
      await env.R2.put(key, JSON.stringify({ date: today, feeds: feeds || [], blocked: blocked || [] }), {
        httpMetadata: { contentType: 'application/json' }
      })
    }
  }

  return { processed: due.length, skipped: allSourceUrls.length - due.length }
}
