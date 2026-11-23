// Mentions: a curated blog's post linking another curated blog. Harvested
// from the posts the cron already fetched, so it costs no extra requests.
import { makeId } from './db-sources.js'
import { getAllMentionRows, newestMentions, mentionStatements } from './db-mentions.js'
import { urlMatchKey } from './url-normalize.js'
import { blogDomain } from './utils.js'

// a batch is one D1 query however many statements it holds; chunked so a
// big heal never sends one giant transaction
const BATCH_STATEMENTS = 100

export const VIDEO_DOMAINS = new Set(['youtube.com', 'youtu.be', 'vimeo.com', 'dailymotion.com', 'twitch.tv', 'rumble.com'])

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
  // one paged read for every domain, not a read per domain - 230 domains
  // was ~600 D1 queries a run, creeping on the 1000-per-invocation cap
  const storedByDomain = await getAllMentionRows(db)
  for (const domain of storedByDomain.keys()) {
    if (!byTarget.has(domain)) byTarget.set(domain, [])
  }

  if (!byTarget.size) return

  const deletes = []
  const updates = []
  const inserts = []
  for (const [domain, newItems] of byTarget) {
    const storedRows = storedByDomain.get(domain) || []
    const existing = newestMentions(storedRows)
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
    const diff = mentionStatements(db, domain, storedRows, updated)
    deletes.push(...diff.deletes)
    updates.push(...diff.updates)
    inserts.push(...diff.inserts)
  }

  // every delete first: UNIQUE(from_post, to_url) spans domains
  const stmts = [...deletes, ...updates, ...inserts]
  for (let i = 0; i < stmts.length; i += BATCH_STATEMENTS) {
    await db.batch(stmts.slice(i, i + BATCH_STATEMENTS))
  }
}
