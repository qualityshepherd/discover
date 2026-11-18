import { parseFeed } from './feedParser.js'
import { makeId, getSourceData, getSourceDataBulk, saveSourceData, updateSourceMeta, getAllSourceUrls, getStaleSourceMeta } from './db-sources.js'
import { getFeeds, saveFeed } from './db-feeds.js'
import { getBlocked, getDismissedDomains, getCandidates, saveCandidates, isUrlBlocked } from './db-moderation.js'
import { getMentions, saveMentions } from './db-mentions.js'
import { urlMatchKey } from './url-normalize.js'
import { getCronState, setCronState } from './db-auth.js'
import { savePostTags } from './db-search.js'

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

// Each fork should identify itself as its own instance, not as the original.
const discoverUA = (domain) => domain ? `discover/1.0 (+https://${domain}; RSS reader)` : 'discover/1.0 (RSS reader)'
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

// Manual redirect following — each hop is a counted subrequest on CF free tier.
// Cap at 2 hops (3 total fetches max) so BATCH_SIZE=15 stays under the 50 limit.
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

export const fetchAndSaveSource = async (db, url, domain) => {
  const now = Date.now()
  const result = await fetchSource(url, 20, domain)
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
    const fromDomain = blogDomain(sourceUrl, data)
    if (!fromDomain) continue
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
          // per href, not per domain - a roundup linking three of your
          // posts is three mentions. same page linked twice is still one.
          const dedupeKey = `${fromHash}:${post.url}:${urlMatchKey(href) || href}`
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

  // domains whose only mentions are historical never appear in the fresh
  // harvest, but their stored rows still need the prune/dedupe pass below
  // - a heal that waits for fresh data never heals them
  const stored = await db.prepare('SELECT DISTINCT to_domain FROM mentions').all()
  for (const row of stored.results) {
    if (!byTarget.has(row.to_domain)) byTarget.set(row.to_domain, [])
  }

  if (!byTarget.size) return

  await Promise.all([...byTarget.entries()].map(async ([domain, newItems]) => {
    const existing = await getMentions(db, domain)
    // identity is normalized on purpose - a feed respelling its own urls
    // (www. appearing, trailing slash) must replace its old rows, not
    // stack next to them. bit us for real: alvinashcraft.com doubled.
    const norm = (u) => urlMatchKey(u) || u || ''
    const key = (m) => `${norm(m.fromSource)}:${norm(m.fromPost)}:${norm(m.toUrl)}`
    const existingByKey = new Map(existing.map(m => [key(m), m]))
    // A mention seen again keeps its original foundAt; only genuinely new ones get "now"
    const items = newItems.map(m => {
      const prev = existingByKey.get(key(m))
      return prev ? { ...m, foundAt: prev.foundAt } : m
    })
    const newKeys = new Set(items.map(key))
    // deliberately NO pruning by source membership here - feed urls drift
    // (redirects, domain renames, path changes) and an automatic prune
    // keyed on exact spelling ate real mentions once. rows from genuinely
    // removed sources can linger; that's a curation chore, not data loss.
    const kept = existing.filter(m => !newKeys.has(key(m)))
    // historical rows can hold both spellings of the same post from
    // before normalization - a rebuild never re-harvests posts that left
    // the feed window, so the heal has to happen here: newest wins
    const seen = new Set()
    const updated = [...kept, ...items]
      .sort((a, b) => new Date(b.foundAt) - new Date(a.foundAt))
      .filter(m => {
        const k = key(m)
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
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
  'wp.com', 'wordpress.com',
  // big sites everyone links that aren't blogs. exact match, so
  // someone.substack.com still counts - only the platform itself is out
  'medium.com', 'goodreads.com', 'mastodon.social', 'bsky.app', 'threads.net',
  'substack.com', 'reuters.com', 'bbc.co.uk', 'bbc.com', 'nytimes.com',
  'theguardian.com', 'washingtonpost.com', 'apnews.com', 'bloomberg.com',
  'cnn.com', 'npr.org', 'imdb.com', 'spotify.com', 'open.spotify.com',
  'news.ycombinator.com', 'stackoverflow.com', 'en.wikipedia.org',
  'doi.org', 'commons.wikimedia.org', 'kickstarter.com', 'buttondown.com'
])

// probes are mostly waiting on the network, not cpu, so this can be
// generous - a wall of feedless news sites shouldn't take a week to clear
export const PROBES_PER_RUN = 10

// Reads just the start of a response - enough to see <rss or <feed - then
// hangs up, so a probe never downloads someone's whole homepage twice
const peek = async (res, maxBytes = 8192) => {
  const reader = res.body?.getReader()
  if (!reader) return ''
  let text = ''
  const decoder = new TextDecoder()
  while (text.length < maxBytes) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  await reader.cancel().catch(() => {})
  return text
}

const looksLikeFeed = text => /<(rss|feed|rdf:RDF)[\s>]/i.test(text)

// A <link> tag's attributes come in any order - matching type-then-href as
// one regex swapped its groups for href-then-type pages and "found" feeds
// at https://site/rss that were never there.
export const findFeedLink = (html, base) => {
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/type=["']application\/(rss|atom)\+xml["']/i.test(tag)) continue
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1]
    if (!href) continue
    try { return new URL(href.replace(/&amp;/g, '&'), base).href } catch {}
  }
  return null
}

// Every answer is checked by reading it: a content-type saying "xml" isn't
// proof (app pages and error pages say it too - play.google.com/atom.xml).
export const probeFeedUrl = async (domain, myDomain, _fetch = fetch) => {
  const get = (url, ms) => _fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'User-Agent': discoverUA(myDomain) } })
  const isFeed = async (url) => {
    try {
      const res = await get(url, 4000)
      return res.ok && looksLikeFeed(await peek(res))
    } catch { return false }
  }
  try {
    const res = await get(`https://${domain}`, 5000)
    if (res.ok) {
      const declared = findFeedLink(await res.text(), `https://${domain}/`)
      if (declared && await isFeed(declared)) return declared
    }
  } catch {}
  for (const p of ['/feed', '/rss', '/atom.xml', '/feed.xml', '/rss.xml', '/index.xml']) {
    if (await isFeed(`https://${domain}${p}`)) return `https://${domain}${p}`
  }
  return null
}

const PROBE_RETRY_MS = 30 * 86400000

// Fewest votes first. One or two of your blogs linking someone is a friend
// or a find; 3+ is overwhelmingly a magazine, a platform or a hot take.
// Ties go newest first so fresh singletons rotate through.
const quietFirst = (a, b) => (a.score - b.score) || String(b.firstSeen || '').localeCompare(String(a.firstSeen || ''))

const host = u => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return '' } }

// site url, else where its posts live, else the feed's own host
export const blogDomain = (feedUrl, data) =>
  host(data?.siteUrl) || host(data?.posts?.find(p => p.url)?.url) || host(feedUrl)

// a vote is a blog, not a feed - one blog curated twice (posts + podcast)
// is still one person vouching. votes are stored as blog domains; older
// rows hold feed urls, so both spellings land on the same key
const voters = sources => new Set(sources.map(s => host(s) || s)).size

export const buildCurateCandidates = async (db, sourceUrls, freshData, _probe = probeFeedUrl, myDomain, _random = Math.random) => {
  if (!freshData.size) return

  const knownDomains = new Set()
  for (const url of sourceUrls) {
    try { knownDomains.add(new URL(url).hostname.replace(/^www\./, '')) } catch {}
  }
  // a feed on feedburner/feedpress isn't the blog - the blog is where its
  // site and posts live. without this every feedburner blog was one voter,
  // and a curated blog could show up as a candidate for itself
  for (const [url, data] of freshData) knownDomains.add(blogDomain(url, data))

  const dismissed = new Set(await getDismissedDomains(db))
  const blocked = await getBlocked(db)
  const isOut = domain => !domain || SKIP_CURATE_DOMAINS.has(domain) || dismissed.has(domain) || isUrlBlocked(`https://${domain}`, blocked)
  const domainSources = new Map()

  for (const [sourceUrl, data] of freshData) {
    if (!data?.posts?.length) continue
    const fromDomain = blogDomain(sourceUrl, data)
    if (!fromDomain) continue
    for (const post of data.posts) {
      if (!post.content) continue
      for (const [, href] of post.content.matchAll(/href=["']([^"']+)["']/g)) {
        try {
          const link = new URL(href)
          // mailto:, tel: and friends parse fine with no hostname - all of them
          // were scoring as one domain called "" (26 votes, top of the queue)
          if (link.protocol !== 'http:' && link.protocol !== 'https:') continue
          const domain = link.hostname.replace(/^www\./, '')
          if (domain === fromDomain) continue
          if (VIDEO_DOMAINS.has(domain) || SKIP_CURATE_DOMAINS.has(domain)) continue
          if (knownDomains.has(domain) || isOut(domain)) continue
          if (!domainSources.has(domain)) domainSources.set(domain, new Set())
          domainSources.get(domain).add(fromDomain)
        } catch {}
      }
    }
  }

  if (!domainSources.size) return

  const scored = [...domainSources.entries()]
    .map(([domain, srcs]) => ({ domain, score: voters([...srcs]), sources: [...srcs] }))
  // shuffle, then a stable sort: ties land in random order. without it,
  // singletons came out in scan order and one prolific linker's list ate
  // every probe turn
  for (let i = scored.length - 1; i > 0; i--) {
    const j = Math.floor(_random() * (i + 1));
    [scored[i], scored[j]] = [scored[j], scored[i]]
  }
  scored.sort(quietFirst)

  // blocked, dismissed or skip-listed after it became a candidate - drop it now
  const candidates = (await getCandidates(db)).filter(c => !isOut(c.domain))

  for (const entry of candidates) {
    const srcs = domainSources.get(entry.domain)
    if (srcs) {
      // combined, not the best single scan - one blog this week and another
      // next week is two votes, even if they never share a feed window
      // old rows stored feed urls, which double-count a feedburner blog
      // next to its real domain - the rescan re-finds them by domain
      const kept = entry.sources.filter(s => !s.includes('://'))
      entry.sources = [...new Set([...kept, ...srcs])]
      entry.score = voters(entry.sources)
    }
  }

  const now = new Date().toISOString()
  // a failed probe is remembered as a row with no feed - without that, the
  // same top 3 feedless domains (bsky.app and friends) got re-probed every
  // run and nothing behind them ever got a turn. failures retry after a month.
  const live = candidates.filter(c => c.feedUrl || (Date.now() - Date.parse(c.probedAt || 0)) < PROBE_RETRY_MS)
  const tried = new Set(live.map(c => c.domain))
  const newToProbe = scored.filter(({ domain }) => !tried.has(domain)).slice(0, PROBES_PER_RUN)

  for (const { domain, score, sources } of newToProbe) {
    const feedUrl = await _probe(domain, myDomain)
    live.push({ domain, score, sources, firstSeen: now, probedAt: now, feedUrl: feedUrl || null })
  }

  const found = live.filter(c => c.feedUrl).sort(quietFirst).slice(0, 50)
  const failed = live.filter(c => !c.feedUrl).sort(quietFirst).slice(0, 100)
  await saveCandidates(db, [...found, ...failed])
}

// Daily, not every run: it scores against every source's stored posts (the
// cron's 24 fresh feeds alone would make every overlap look like 1), so it's
// the heaviest pass here, and suggestions don't need to be hourly.
const CURATE_EVERY_MS = 86400000

export const maybeBuildCurateCandidates = async (db, allSourceUrls, freshData, myDomain, _probe = probeFeedUrl, now = Date.now()) => {
  const last = await getCronState(db, 'curate:lastRun')
  if (last && now - Date.parse(last) < CURATE_EVERY_MS) return false
  const stored = await getSourceDataBulk(db, allSourceUrls.filter(u => !freshData.has(u)))
  const all = new Map([...stored, ...freshData])
  await buildCurateCandidates(db, allSourceUrls, all, _probe, myDomain)
  await setCronState(db, 'curate:lastRun', new Date(now).toISOString())
  return true
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
    const result = await fetchSource(url, 20, env.DOMAIN_NAME)

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
  // The cron only changes preview posts, cover image and frequency, so leave feed_sources and the FTS index alone
  if (changedFeeds.length) await Promise.all(changedFeeds.map(f => saveFeed(db, f, { syncChildren: false })))

  const allSourceUrls = await getAllSourceUrls(db)
  await buildLinkGraph(db, allSourceUrls, freshData).catch(err => console.error('buildLinkGraph failed:', err))
  await maybeBuildCurateCandidates(db, allSourceUrls, freshData, env.DOMAIN_NAME).catch(err => console.error('buildCurateCandidates failed:', err))

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
