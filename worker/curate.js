// Curate suggestions: blogs your blogs link to, found, read and checked
// by machine, so the list you see is only ones worth a look.
import { getBlocked, getDismissedDomains, getCandidates, saveCandidates, isUrlBlocked } from './db-moderation.js'
import { getSourceDataBulk } from './db-sources.js'
import { getCronState, setCronState } from './db-auth.js'
import { feedStats, rejectReason, consentSignals } from './feed-stats.js'
import { fetchSource, discoverUA } from './fetch-source.js'
import { VIDEO_DOMAINS } from './link-graph.js'
import { bareHost, blogDomain } from './utils.js'

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

// a probe now reads the whole feed, and parsing is cpu - 3 a run fits the
// free plan forever. the rebuild button takes bigger bites.
export const PROBES_PER_RUN = 3
export const REBUILD_PROBES = 50
const PROBE_CONCURRENCY = 5

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
// seen.html gets the homepage, so its consent signals cost no extra fetch
export const probeFeedUrl = async (domain, myDomain, _fetch = fetch, seen = {}) => {
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
      seen.html = await res.text()
      const declared = findFeedLink(seen.html, `https://${domain}/`)
      if (declared && await isFeed(declared)) return declared
    }
  } catch {}
  for (const p of ['/feed', '/rss', '/atom.xml', '/feed.xml', '/rss.xml', '/index.xml']) {
    if (await isFeed(`https://${domain}${p}`)) return `https://${domain}${p}`
  }
  return null
}

// find the feed, then read it for real so the checks have posts to look at
export const probeCandidate = async (domain, myDomain) => {
  const seen = {}
  const feedUrl = await probeFeedUrl(domain, myDomain, fetch, seen)
  if (!feedUrl) return null
  const r = await fetchSource(feedUrl, 20, myDomain)
  return { feedUrl, posts: r.posts || [], siteUrl: r.siteUrl || null, language: r.language || null, generator: r.generator || null, consent: consentSignals(seen.html) }
}

const PROBE_RETRY_MS = 30 * 86400000
// a machine no is soft - blogs change, and the checks are guesses
const REJECT_RETRY_MS = 90 * 86400000

// Fewest votes first. One or two of your blogs linking someone is a friend
// or a find; 3+ is overwhelmingly a magazine, a platform or a hot take.
// Ties go newest first so fresh singletons rotate through.
const quietFirst = (a, b) => (a.score - b.score) || String(b.firstSeen || '').localeCompare(String(a.firstSeen || ''))

// a vote is a blog, not a feed - one blog curated twice (posts + podcast)
// is still one person vouching. votes are stored as blog domains; older
// rows hold feed urls, so both spellings land on the same key
const voters = sources => new Set(sources.map(s => bareHost(s) || s)).size

export const buildCurateCandidates = async (db, sourceUrls, freshData, _probe = probeCandidate, myDomain, _random = Math.random, { probes = PROBES_PER_RUN, now: nowMs = Date.now() } = {}) => {
  if (!freshData.size) return { probed: 0, passed: 0 }

  const knownDomains = new Set(sourceUrls.map(bareHost).filter(Boolean))
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

  if (!domainSources.size) return { probed: 0, passed: 0 }

  const scored = [...domainSources.entries()]
    .map(([domain, srcs]) => ({ domain, score: voters([...srcs]), sources: [...srcs] }))
  // shuffle then a stable sort, so ties come out random. in scan order one
  // prolific linker's list ate every probe turn
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
      // votes add up across scans. old rows stored feed urls, which
      // double-counted feedburner blogs - the rescan re-finds them by domain
      const kept = entry.sources.filter(s => !s.includes('://'))
      entry.sources = [...new Set([...kept, ...srcs])]
      entry.score = voters(entry.sources)
    }
  }

  const now = new Date(nowMs).toISOString()
  const age = c => nowMs - Date.parse(c.probedAt || 0)
  // failed probes are remembered (no feed) so the queue keeps moving, and
  // retried after a month; machine no's after three. a row with a feed but
  // no stats predates the checks and gets read again
  const live = candidates.filter(c => {
    if (!c.feedUrl) return age(c) < PROBE_RETRY_MS
    if (c.rejected) return age(c) < REJECT_RETRY_MS
    return !!c.stats
  })
  const tried = new Set(live.map(c => c.domain))
  const newToProbe = scored.filter(({ domain }) => !tried.has(domain)).slice(0, probes)

  const probeOne = async ({ domain, score, sources }) => {
    const found = await _probe(domain, myDomain)
    const stats = found ? feedStats(found, domain, knownDomains) : null
    const rejected = stats ? rejectReason(stats, nowMs) : null
    // a re-probed row keeps its votes and first sighting
    const prev = candidates.find(c => c.domain === domain)
    return { domain, score: prev?.score ?? score, sources: prev?.sources ?? sources, firstSeen: prev?.firstSeen || now, probedAt: now, feedUrl: found?.feedUrl || null, stats, rejected }
  }
  // a few at a time - 50 in a row runs past cloudflare's 100s request limit
  for (let i = 0; i < newToProbe.length; i += PROBE_CONCURRENCY) {
    live.push(...await Promise.all(newToProbe.slice(i, i + PROBE_CONCURRENCY).map(probeOne)))
  }

  // no cap - the checks cull, and a stored row is a probe never repeated
  await saveCandidates(db, live)
  const probedNow = live.slice(live.length - newToProbe.length)
  return { probed: newToProbe.length, passed: probedNow.filter(c => c.feedUrl && !c.rejected).length }
}

// daily: it scores against every source's stored posts, not just this
// run's batch, so it's the heaviest pass here
const CURATE_EVERY_MS = 86400000

export const maybeBuildCurateCandidates = async (db, allSourceUrls, freshData, myDomain, _probe = probeCandidate, now = Date.now()) => {
  const last = await getCronState(db, 'curate:lastRun')
  if (last && now - Date.parse(last) < CURATE_EVERY_MS) return false
  const stored = await getSourceDataBulk(db, allSourceUrls.filter(u => !freshData.has(u)))
  const all = new Map([...stored, ...freshData])
  await buildCurateCandidates(db, allSourceUrls, all, _probe, myDomain, Math.random, { now })
  await setCronState(db, 'curate:lastRun', new Date(now).toISOString())
  return true
}
