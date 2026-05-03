import { memberByToken, isOwnerPubkey } from './auth.js'
import { json, parseJsonBody } from './utils.js'
import {
  makeId, computeTags,
  getFeed, saveFeed, getFeeds, addToIndex, removeFromIndex,
  getSourceIndex, getSourceData, deleteSourceData,
  KV_SOURCE_INDEX, KV_SOURCE_PREFIX,
  getPending, getBlocked, isBlocked,
  KV_PREFIX, KV_PENDING, KV_BLOCKED,
  getCurator, saveCurator, deleteCurator, listCurators, addToCuratorIndex,
  isCuratorOf, shouldUpdateLastSeen,
  getUserFeedSlug, setUserFeedSlug, getUserFeed, setUserFeed
} from './discover-kv.js'
import { checkDiscoverFeeds, computeFrequency, fetchAndSaveSource, applySourceDatas, fetchSource, buildLinkGraph, buildCurateCandidates, VIDEO_DOMAINS, findImage } from './discover-cron.js'

// re-export for worker/index.js and tests
export { checkDiscoverFeeds, computeFrequency, makeId, computeTags }

// Detect feeds where every post has no real text content (click-through-only)
export const isClickThrough = (posts) => {
  if (!posts?.length) return false
  return !posts.some(p => {
    const text = (p.content || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
    return text.length > 100
  })
}

const cors = (res) => {
  res.headers.set('Access-Control-Allow-Origin', '*')
  return res
}

const xmlAttr = (s) => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const toOpml = (feeds) => {
  const outlines = feeds.flatMap(f =>
    (f.sources || []).map(url =>
      `    <outline type="rss" text="${xmlAttr(f.title)}" xmlUrl="${xmlAttr(url)}"/>`
    )
  ).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="1.0">\n  <head><title>discover</title></head>\n  <body>\n${outlines}\n  </body>\n</opml>`
}

// public routes

// GET /api/discover — list all approved feeds/playlists
const handleList = async (kv, url) => {
  const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000
  const [feeds, sourceIndex] = await Promise.all([getFeeds(kv), getSourceIndex(kv)])
  const allFeeds = feeds || []
  const tag = url.searchParams.get('tag')
  const q = url.searchParams.get('q')?.toLowerCase()

  let results = allFeeds.filter(f => (f.sources || []).length > 0)
  if (tag) results = results.filter(f => f.tags?.includes(tag))
  if (q) {
    results = results.filter(f =>
      f.title.toLowerCase().includes(q) ||
      f.description?.toLowerCase().includes(q) ||
      f.tags?.some(t => t.includes(q)) ||
      (f.sources || []).some(s => s.toLowerCase().includes(q))
    )
  }

  const sorted = results
    .sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0) || (b.imports || 0) - (a.imports || 0))
    .map(({ previewPosts, ...f }) => f)

  const cutoff = Date.now() - TWO_WEEKS
  const hasNew = Object.values(sourceIndex).some(s => s.addedAt && new Date(s.addedAt).getTime() > cutoff)

  const mentionCounts = {}
  for (const [hash, entry] of Object.entries(sourceIndex)) {
    if (entry.mentionCount) mentionCounts[hash] = entry.mentionCount
  }

  const body = JSON.stringify({ feeds: sorted, tags: computeTags(allFeeds), hasNew, mentionCounts })
  const headers = { 'Content-Type': 'application/json' }
  if (!tag && !q) headers['Cache-Control'] = 'public, max-age=1800'
  return cors(new Response(body, { headers }))
}

// GET /api/discover/:id — preview posts served from KV, populated by cron
const handlePlaylist = async (kv, id) => {
  const entry = await getFeed(kv, id)
  if (!entry) return json({ error: 'not found' }, 404)
  const posts = entry.previewPosts || []
  return cors(new Response(JSON.stringify(posts), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }
  }))
}

// GET /api/discover/:id/rss — RSS feed for a playlist
const handlePlaylistRss = async (kv, id, reqUrl) => {
  const entry = await getFeed(kv, id)
  if (!entry) return json({ error: 'not found' }, 404)

  const sourceDatas = await Promise.all((entry.sources || []).map(url => getSourceData(kv, url)))
  const posts = sourceDatas
    .filter(Boolean)
    .flatMap(s => s.posts || [])
    .sort((a, b) => new Date(b.date) - new Date(a.date))

  const base = new URL(reqUrl).origin
  const items = posts.map(p => `
    <item>
      <title>${xmlAttr(p.title)}</title>
      <link>${xmlAttr(p.url)}</link>
      <guid>${xmlAttr(p.url)}</guid>
      ${p.date ? `<pubDate>${new Date(p.date).toUTCString()}</pubDate>` : ''}
      ${p.author || p.feed?.title ? `<author>${xmlAttr(p.author || p.feed?.title)}</author>` : ''}
      ${p.feed?.title ? `<source url="${xmlAttr(p.feed.url)}">${xmlAttr(p.feed.title)}</source>` : ''}
    </item>`).join('')

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${xmlAttr(entry.title)} · discover</title>
    <description>${xmlAttr(entry.description)}</description>
    <link>${base}/discover/${id}</link>
    ${items}
  </channel>
</rss>`

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=1800'
    }
  })
}

// GET /api/discover/:id/opml — OPML for a single playlist
const handleOpml = async (kv, id) => {
  let entry
  if (id === 'all') {
    const feeds = await getFeeds(kv) || []
    entry = { title: 'discover', sources: feeds.flatMap(f => f.sources || []) }
  } else {
    entry = await getFeed(kv, id)
  }
  if (!entry) return json({ error: 'not found' }, 404)

  return new Response(toOpml([entry]), {
    headers: {
      'Content-Type': 'text/x-opml',
      'Content-Disposition': `attachment; filename="discover-${id}.opml"`
    }
  })
}

// Resolve source data for a list of URLs: try source:all, fall back to individual KV,
// live-fetch anything still missing (custom OPML feeds never written to KV).
const resolveSourceAll = async (kv, allSourceUrls) => {
  const sourceAll = await kv.get('source:all', { type: 'json' }) || {}

  const missing = allSourceUrls.filter(u => !sourceAll[makeId(u)])
  if (missing.length) {
    const fallbacks = await Promise.all(missing.map(u => getSourceData(kv, u)))
    missing.forEach((u, i) => { if (fallbacks[i]) sourceAll[makeId(u)] = fallbacks[i] })
  }

  const stillMissing = missing.filter(u => !sourceAll[makeId(u)])
  if (stillMissing.length) {
    let cacheUpdated = false
    for (const url of stillMissing) {
      const result = await fetchSource(url, 3)
      if (!result.posts?.length) continue
      const posts = result.posts.slice(0, 3).map(p => ({
        title: p.title, url: p.url, date: p.date, author: p.author, feed: p.feed, content: p.content
      }))
      sourceAll[makeId(url)] = { url, posts, image: findImage(result.posts) || null, siteUrl: result.siteUrl || null }
      cacheUpdated = true
    }
    if (cacheUpdated) await kv.put('source:all', JSON.stringify(sourceAll))
  }

  return sourceAll
}

// POST /api/discover/feed — merged posts from followed playlists
const handleFeed = async (kv, req) => {
  const body = await parseJsonBody(req)
  const ids = Array.isArray(body?.ids) ? body.ids.filter(Boolean) : []
  const sourceUrls = Array.isArray(body?.sources) ? body.sources.filter(Boolean) : []
  if (!ids.length && !sourceUrls.length) return cors(json({ posts: [] }))

  const feeds = (await Promise.all(ids.map(id => getFeed(kv, id)))).filter(Boolean)
  const allSourceUrls = [...new Set([...feeds.flatMap(f => f.sources || []), ...sourceUrls])]

  const sourceAll = await resolveSourceAll(kv, allSourceUrls)

  const seen = new Set()
  const posts = allSourceUrls
    .map(u => sourceAll[makeId(u)])
    .filter(Boolean)
    .flatMap(s => s.posts || [])
    .filter(p => { if (!p.url || seen.has(p.url)) return false; seen.add(p.url); return true })
    .sort((a, b) => new Date(b.date) - new Date(a.date))

  return cors(json({ posts }))
}

// POST /api/discover/feed/opml — OPML of followed playlists' sources
const handleFeedOpml = async (kv, req) => {
  const { ids = [], sources = [] } = await req.json().catch(() => ({}))
  const feeds = ids.length ? (await Promise.all(ids.map(id => getFeed(kv, id)))).filter(Boolean) : []
  if (sources.length) feeds.push({ title: 'followed sources', sources })
  return new Response(toOpml(feeds), {
    headers: {
      'Content-Type': 'text/x-opml',
      'Content-Disposition': 'attachment; filename="feed.opml"'
    }
  })
}

// GET /api/discover/random — random posts across all playlists, one per source
const handleRandom = async (kv, url) => {
  const n = Math.min(parseInt(url.searchParams.get('n') || '20', 10), 50)
  const feeds = await getFeeds(kv) || []
  const posts = []
  for (const feed of feeds) {
    for (const post of (feed.previewPosts || [])) {
      if (post?.url) posts.push({ ...post, fromPlaylist: feed.title, fromPlaylistId: feed.id })
    }
  }
  for (let i = posts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [posts[i], posts[j]] = [posts[j], posts[i]]
  }
  // dedup by source feed URL — same source may appear in multiple playlists
  const seen = new Set()
  const deduped = posts.filter(p => {
    const key = p.feed?.url || p.url
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return cors(json(deduped.slice(0, n)))
}

// GET /api/discover/new — newest posts across all sources, one per source sorted by date
const handleNew = async (kv) => {
  const [feeds, sourceAll] = await Promise.all([getFeeds(kv) || [], kv.get('source:all', { type: 'json' })])
  const allSourceUrls = [...new Set((feeds).flatMap(f => f.sources || []))]
  const src = sourceAll || {}
  const posts = allSourceUrls
    .map(url => {
      const data = src[makeId(url)]
      if (!data?.posts?.length) return null
      const playlist = feeds.find(f => (f.sources || []).includes(url))
      return {
        ...data.posts[0],
        fromPlaylist: playlist?.title || new URL(url).hostname,
        fromPlaylistId: playlist?.id || null
      }
    })
    .filter(p => p?.date)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
  return cors(json(posts))
}

// POST /api/discover/preview — fetch a feed URL server-side, return metadata; saves nothing
const handlePreview = async (req, kv) => {
  const origin = req.headers.get('origin') || ''
  const host = new URL(req.url).host
  let originHost; try { originHost = new URL(origin).host } catch { originHost = '' }
  if (originHost !== host) return json({ error: 'forbidden' }, 403)
  const body = await parseJsonBody(req)
  if (!body) return json({ error: 'invalid json' }, 400)
  const url = body.url?.trim().replace(/\/+$/, '')
  if (!url) return json({ error: 'url required' }, 400)
  if (!URL.canParse(url)) return json({ error: 'invalid url' }, 400)

  // Same-host feeds — serve from KV directly to avoid self-request loop
  const parsed = new URL(url)
  if (parsed.host === host) {
    const mentionsMatch = parsed.pathname.match(/^\/api\/mentions\/([^/]+)\.xml$/)
    if (mentionsMatch) {
      const mentions = await kv.get(`mentions:${mentionsMatch[1]}`, { type: 'json' }) || []
      const posts = mentions.slice(0, 2).map(m => ({ title: m.fromTitle || m.fromPost, url: m.fromPost, date: m.fromDate, feed: { title: `mentions · ${mentionsMatch[1]}` } }))
      return cors(json({ title: `mentions · ${mentionsMatch[1]}`, image: null, posts, siteUrl: null }))
    }
    const rssMatch = parsed.pathname.match(/^\/api\/discover\/([^/]+)\/rss$/)
    if (!rssMatch) return cors(json({ error: 'use the follow button on the discover page instead' }, 422))
    const feed = await getFeed(kv, rssMatch[1])
    if (!feed) return cors(json({ error: 'playlist not found' }, 422))
    const sourceDatas = await Promise.all((feed.sources || []).map(u => getSourceData(kv, u)))
    const posts = sourceDatas.filter(Boolean).flatMap(s => s.posts || []).sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 2).map(p => ({ title: p.title, url: p.url, date: p.date, author: p.author, feed: p.feed, content: p.content }))
    const image = sourceDatas.filter(Boolean).map(s => s.image).find(Boolean) || null
    return cors(json({ title: feed.title, image, posts, siteUrl: null }))
  }

  const result = await fetchSource(url, 10)
  if (!result.posts) return cors(json({ error: result.statusCode ? `HTTP ${result.statusCode}` : (result.error || 'could not fetch feed') }, 422))
  if (!result.posts.length) return cors(json({ error: 'no posts found' }, 422))
  const title = result.posts[0]?.feed?.title || new URL(url).hostname
  const image = findImage(result.posts)
  const posts = result.posts.slice(0, 2).map(p => ({ title: p.title, url: p.url, date: p.date, author: p.author, feed: p.feed, content: p.content }))
  return cors(json({ title, image, posts, siteUrl: result.siteUrl || null }))
}

// POST /api/discover/submit — public submission, no auth
const handleSubmit = async (req, kv) => {
  const body = await parseJsonBody(req)
  if (!body) return json({ error: 'invalid json' }, 400)

  const url = body.url?.trim().replace(/\/+$/, '')
  if (!url) return json({ error: 'url required' }, 400)
  if (!URL.canParse(url)) return json({ error: 'invalid url' }, 400)

  // Always return ok to prevent enumeration — silently drop invalid/blocked/duplicate
  const ok = json({ ok: true })

  if (await isBlocked(kv, [url])) return ok

  const [feeds, pending] = await Promise.all([getFeeds(kv), getPending(kv)])
  if ((feeds || []).some(f => (f.sources || []).includes(url))) return ok
  if ((pending || []).some(f => f.url === url)) return ok

  // Validate feed: must be alive, have posts, not click-through-only
  const result = await fetchSource(url, 5)
  if (!result.posts?.length) return ok
  if (isClickThrough(result.posts)) return ok

  const title = result.posts[0]?.feed?.title || new URL(url).hostname
  const item = {
    url,
    title: title || new URL(url).hostname,
    description: '',
    submittedAt: new Date().toISOString()
  }
  const updated = [...(pending || []), item]
  await kv.put(KV_PENDING, JSON.stringify(updated))
  return ok
}

// POST /api/discover/:id/import — increment import count
const handleImport = async (kv, id) => {
  const feed = await getFeed(kv, id)
  if (!feed) return json({ error: 'not found' }, 404)
  feed.imports = (feed.imports || 0) + 1
  await saveFeed(kv, feed)
  return json({ ok: true })
}

// curator routes (owner only)

// GET /api/discover/admin/curator
const handleCuratorList = async (kv) => json(await listCurators(kv))

// POST /api/discover/admin/curator/invite
const handleCuratorInvite = async (req, kv) => {
  const body = await parseJsonBody(req)
  if (!body) return json({ error: 'invalid json' }, 400)
  const { pubkey, name, siteUrl, playlistId } = body
  if (!pubkey || !playlistId) return json({ error: 'pubkey and playlistId required' }, 400)
  const feed = await getFeed(kv, playlistId)
  if (!feed) return json({ error: 'playlist not found' }, 404)
  if (await getCurator(kv, pubkey)) return json({ error: 'already a curator' }, 409)
  const now = new Date().toISOString()
  const curator = { playlistId, name: name?.trim() || '', siteUrl: siteUrl?.trim() || '', createdAt: now, lastSeen: now }
  feed.curatorPubkey = pubkey
  feed.curatorName = curator.name
  feed.curatorUrl = curator.siteUrl
  await Promise.all([saveCurator(kv, pubkey, curator), addToCuratorIndex(kv, pubkey), saveFeed(kv, feed)])
  return json({ ok: true })
}

// DELETE /api/discover/admin/curator/:pubkey
const handleCuratorRevoke = async (kv, pubkey) => {
  const curator = await getCurator(kv, pubkey)
  if (!curator) return json({ error: 'not found' }, 404)
  const feed = curator.playlistId ? await getFeed(kv, curator.playlistId) : null
  if (feed && feed.curatorPubkey === pubkey) {
    delete feed.curatorPubkey
    delete feed.curatorName
    delete feed.curatorUrl
  }
  await Promise.all([deleteCurator(kv, pubkey), ...(feed ? [saveFeed(kv, feed)] : [])])
  return json({ ok: true })
}

// admin routes

// POST /api/discover/admin/validate — owner-only batch URL validation
const handleValidate = async (req, kv) => {
  const body = await parseJsonBody(req)
  if (!body) return json({ error: 'invalid json' }, 400)
  const urls = Array.isArray(body.urls) ? body.urls.slice(0, 20) : []
  if (!urls.length) return json({ error: 'urls required' }, 400)

  const [feeds, pending, blocked] = await Promise.all([getFeeds(kv), getPending(kv), getBlocked(kv)])
  const allSourceUrls = new Set((feeds || []).flatMap(f => f.sources || []))
  const pendingUrls = new Set((pending || []).map(p => p.url))
  const blockedList = blocked || []

  const results = await Promise.all(urls.map(async (rawUrl) => {
    const url = rawUrl?.trim().replace(/\/+$/, '')
    if (!url || !URL.canParse(url)) return { url: rawUrl, status: 'invalid-url' }
    if (blockedList.some(b => { try { return url.includes(b) || new URL(url).hostname.replace(/^www\./, '').includes(b) } catch { return false } })) return { url, status: 'blocked' }
    if (allSourceUrls.has(url)) return { url, status: 'duplicate' }
    if (pendingUrls.has(url)) return { url, status: 'pending' }
    const result = await fetchSource(url, 5)
    if (!result.posts) return { url, status: 'fetch-error', statusCode: result.statusCode, error: result.error }
    if (!result.posts.length) return { url, status: 'no-content' }
    if (isClickThrough(result.posts)) return { url, status: 'click-through' }
    const title = result.posts[0]?.feed?.title || new URL(url).hostname
    return { url, status: 'valid', title, postCount: result.posts.length, samplePost: { title: result.posts[0].title, url: result.posts[0].url } }
  }))
  return json(results)
}

// DELETE /api/discover/admin/pending — reject (remove without approving)
const handlePendingReject = async (req, kv) => {
  const body = await parseJsonBody(req)
  if (!body) return json({ error: 'invalid json' }, 400)
  const url = body.url?.trim()
  if (!url) return json({ error: 'url required' }, 400)
  const pending = await getPending(kv) || []
  const updated = pending.filter(p => p.url !== url)
  if (updated.length === pending.length) return json({ error: 'not found' }, 404)
  await kv.put(KV_PENDING, JSON.stringify(updated))
  return json({ ok: true })
}

// GET /api/discover/admin/pending
const handlePendingList = async (kv) => {
  return json(await getPending(kv) || [])
}

// POST /api/discover/admin/approve — approve a pending submission
const handleApprove = async (req, kv) => {
  const body = await parseJsonBody(req)
  if (!body) return json({ error: 'invalid json' }, 400)

  const pending = await getPending(kv) || []
  const idx = pending.findIndex(f => f.url === body.url)
  if (idx === -1) return json({ error: 'not found' }, 404)
  const item = pending[idx]
  const remaining = pending.filter((_, i) => i !== idx)

  if (body.playlistId) {
    const feed = await getFeed(kv, body.playlistId)
    if (!feed) return json({ error: 'playlist not found' }, 404)
    const sources = [...new Set([...(feed.sources || []), item.url])]
    await Promise.all([
      saveFeed(kv, { ...feed, sources }),
      kv.put(KV_PENDING, JSON.stringify(remaining))
    ])
    return json({ ok: true })
  }

  // no playlist — just dismiss from pending
  await kv.put(KV_PENDING, JSON.stringify(remaining))
  return json({ ok: true })
}

// POST /api/discover/admin/add — add directly without going through pending
const handleAdd = async (req, kv) => {
  const body = await parseJsonBody(req)
  if (!body) return json({ error: 'invalid json' }, 400)

  const sources = Array.isArray(body.sources) ? body.sources : (body.url ? [body.url] : [])

  if (await isBlocked(kv, sources)) return json({ error: 'one or more sources are not accepted' }, 403)

  const title = body.title?.trim()
  if (!title && !sources.length) return json({ error: 'title required' }, 400)
  const id = makeId(sources[0] || title)
  if (await getFeed(kv, id)) return json({ error: 'already exists' }, 409)

  const entry = {
    id,
    type: sources.length > 1 ? 'playlist' : 'feed',
    title: title || new URL(sources[0]).hostname,
    description: body.description?.trim() || '',
    tags: Array.isArray(body.tags) ? body.tags.map(t => String(t).trim().toLowerCase()) : [],
    author: { name: body.author?.name?.trim() || '', url: body.author?.url?.trim() || '', pubkey: '' },
    sources,
    imports: 0,
    featured: body.featured || false,
    active: true,
    updateFrequency: 'unknown',
    lastChecked: null,
    addedAt: new Date().toISOString()
  }
  await Promise.all([saveFeed(kv, entry), addToIndex(kv, id)])
  return json({ ok: true, entry })
}

// PATCH /api/discover/admin/:id — edit an entry
const handleEdit = async (req, kv, id) => {
  const body = await parseJsonBody(req)
  if (!body) return json({ error: 'invalid json' }, 400)

  const feed = await getFeed(kv, id)
  if (!feed) return json({ error: 'not found' }, 404)

  if (body.title !== undefined) feed.title = body.title.trim()
  if (body.description !== undefined) feed.description = body.description.trim()
  if (Array.isArray(body.tags)) feed.tags = body.tags.map(t => String(t).trim().toLowerCase())
  if (Array.isArray(body.sources)) feed.sources = body.sources
  if (body.featured !== undefined) feed.featured = !!body.featured
  if (body.author !== undefined) {
    feed.author = {
      name: body.author.name?.trim() || '',
      url: body.author.url?.trim() || '',
      pubkey: feed.author?.pubkey || ''
    }
  }

  await saveFeed(kv, feed)
  return json({ ok: true })
}

// DELETE /api/discover/admin/:id
const handleDelete = async (kv, id) => {
  const feed = await getFeed(kv, id)
  if (!feed) return json({ error: 'not found' }, 404)
  await Promise.all([
    kv.delete(`${KV_PREFIX}${id}`),
    removeFromIndex(kv, id)
  ])
  return json({ ok: true })
}

// POST /api/discover/admin/source — register a source URL in the index
const handleSourceRegister = async (req, kv) => {
  const body = await parseJsonBody(req)
  if (!body) return json({ error: 'invalid json' }, 400)
  const url = body.url?.trim().replace(/\/+$/, '')
  if (!url) return json({ error: 'url required' }, 400)
  if (!URL.canParse(url)) return json({ error: 'invalid url' }, 400)
  const index = await getSourceIndex(kv)
  const hash = makeId(url)
  if (index[hash]) return json({ ok: true, existing: true })
  const { indexEntry } = await fetchAndSaveSource(kv, url)
  index[hash] = indexEntry
  await kv.put(KV_SOURCE_INDEX, JSON.stringify(index))
  return json({ ok: true, existing: false, source: indexEntry })
}

// POST /api/discover/admin/:id/sources — add source to a playlist
const handlePlaylistSourceAdd = async (req, kv, id) => {
  const body = await parseJsonBody(req)
  if (!body) return json({ error: 'invalid json' }, 400)
  const url = body.url?.trim().replace(/\/+$/, '')
  if (!url) return json({ error: 'url required' }, 400)
  const feed = await getFeed(kv, id)
  if (!feed) return json({ error: 'not found' }, 404)
  if ((feed.sources || []).includes(url)) return json({ ok: true, existing: true })
  feed.sources = [...(feed.sources || []), url]
  const index = await getSourceIndex(kv)
  const hash = makeId(url)

  let sourceData
  if (!index[hash]) {
    const result = await fetchAndSaveSource(kv, url)
    index[hash] = result.indexEntry
    sourceData = result.sourceData
    await kv.put(KV_SOURCE_INDEX, JSON.stringify(index))
  } else {
    sourceData = await getSourceData(kv, url)
  }

  if (sourceData?.posts?.length) {
    feed.previewPosts = [...(feed.previewPosts || []), sourceData.posts[0]]
    if (!feed.coverImage && sourceData.image) feed.coverImage = sourceData.image
  }

  await saveFeed(kv, feed)
  return json({ ok: true })
}

// POST /api/discover/admin/:id/refresh — fetch unindexed sources, recompute previewPosts from current sources only
const handlePlaylistRefresh = async (kv, id) => {
  const feed = await getFeed(kv, id)
  if (!feed) return json({ error: 'not found' }, 404)
  if (!feed.sources?.length) return json({ ok: true, fetched: 0 })

  const index = await getSourceIndex(kv)
  let fetched = 0

  const sourceDatas = await Promise.all(feed.sources.map(async url => {
    const hash = makeId(url)
    if (!index[hash]) {
      const { sourceData, indexEntry } = await fetchAndSaveSource(kv, url)
      index[hash] = indexEntry
      fetched++
      return sourceData
    }
    return getSourceData(kv, url)
  }))

  if (fetched) await kv.put(KV_SOURCE_INDEX, JSON.stringify(index))

  applySourceDatas(feed, sourceDatas)
  feed.lastUpdated = new Date().toISOString()

  await saveFeed(kv, feed)
  return json({ ok: true, fetched })
}

// DELETE /api/discover/admin/:id/sources — remove source from a playlist; delete KV if orphaned; recompute previewPosts immediately
const handlePlaylistSourceRemove = async (req, kv, id) => {
  const body = await parseJsonBody(req)
  if (!body) return json({ error: 'invalid json' }, 400)
  const url = body.url?.trim().replace(/\/+$/, '')
  if (!url) return json({ error: 'url required' }, 400)
  const [feed, allFeeds] = await Promise.all([getFeed(kv, id), getFeeds(kv)])
  if (!feed) return json({ error: 'not found' }, 404)
  feed.sources = (feed.sources || []).filter(s => s !== url)
  const stillReferenced = (allFeeds || []).some(f => f.id !== id && (f.sources || []).includes(url))

  const sourceDatas = await Promise.all(feed.sources.map(u => getSourceData(kv, u)))
  applySourceDatas(feed, sourceDatas)

  await Promise.all([
    saveFeed(kv, feed),
    stillReferenced ? Promise.resolve() : deleteSourceData(kv, url)
  ])
  return json({ ok: true })
}

// PATCH /api/discover/admin/source — rename a source URL across all playlists
const handleSourceEdit = async (req, kv) => {
  const body = await parseJsonBody(req)
  if (!body) return json({ error: 'invalid json' }, 400)
  const oldUrl = body.oldUrl?.trim()
  const newUrl = body.newUrl?.trim().replace(/\/+$/, '')
  if (!oldUrl || !newUrl) return json({ error: 'oldUrl and newUrl required' }, 400)
  if (!URL.canParse(newUrl)) return json({ error: 'invalid url' }, 400)

  const [feeds, index] = await Promise.all([getFeeds(kv) || [], getSourceIndex(kv)])
  if (oldUrl === newUrl && index[makeId(oldUrl)]?.lastFetched) return json({ ok: true, affected: 0 })
  const affected = (feeds || []).filter(f => (f.sources || []).includes(oldUrl))
  affected.forEach(f => { f.sources = f.sources.map(s => s === oldUrl ? newUrl : s) })

  const oldHash = makeId(oldUrl)
  const newHash = makeId(newUrl)
  delete index[oldHash]

  // only refetch if the new URL isn't already in the index with fresh data
  let sourceData, indexEntry
  if (index[newHash]?.lastFetched) {
    indexEntry = index[newHash]
    sourceData = await getSourceData(kv, newUrl)
  } else {
    ;({ sourceData, indexEntry } = await fetchAndSaveSource(kv, newUrl))
  }
  index[newHash] = { ...indexEntry, addedAt: index[oldHash]?.addedAt || index[newHash]?.addedAt || indexEntry.addedAt }

  for (const feed of affected) {
    const sourceDatas = await Promise.all(
      (feed.sources || []).map(u => u === newUrl ? sourceData : getSourceData(kv, u))
    )
    if (!sourceDatas.filter(Boolean).length) continue
    applySourceDatas(feed, sourceDatas, { keepOnEmpty: true })
  }

  await Promise.all([
    ...affected.map(f => saveFeed(kv, f)),
    kv.put(KV_SOURCE_INDEX, JSON.stringify(index)),
    kv.delete(`${KV_SOURCE_PREFIX}${oldHash}`)
  ])
  return json({ ok: true, affected: affected.length })
}

// DELETE /api/discover/admin/source — remove a source URL from all playlists
const handleSourceDelete = async (req, kv) => {
  const body = await parseJsonBody(req)
  if (!body) return json({ error: 'invalid json' }, 400)
  const url = body.url?.trim().replace(/\/+$/, '')
  if (!url) return json({ error: 'url required' }, 400)

  const feeds = await getFeeds(kv) || []
  const affected = feeds.filter(f => (f.sources || []).includes(url))
  await Promise.all([
    ...affected.map(f => { f.sources = f.sources.filter(s => s !== url); return saveFeed(kv, f) }),
    deleteSourceData(kv, url)
  ])
  return json({ ok: true, affected: affected.length })
}

// GET /api/discover/admin/blocked
const handleBlockedList = async (kv) => json(await getBlocked(kv) || [])

// PUT /api/discover/admin/blocked — replace entire blocked list atomically
const handleBlockedSave = async (req, kv) => {
  const body = await parseJsonBody(req)
  if (!body || !Array.isArray(body.entries)) return json({ error: 'entries array required' }, 400)
  const entries = [...new Set(body.entries.map(e => String(e).trim()).filter(Boolean))]
  await kv.put(KV_BLOCKED, JSON.stringify(entries))
  return json({ ok: true, count: entries.length })
}

// GET /api/mentions/:sourceId.xml — RSS feed of posts from other discover sources linking to this source
export const handleMentionsFeed = async (kv, sourceId, reqUrl) => {
  const [mentions, sourceIndex] = await Promise.all([
    kv.get(`mentions:${sourceId}`, { type: 'json' }),
    getSourceIndex(kv)
  ])
  const items = mentions || []
  const sourceEntry = Object.values(sourceIndex).find(s => makeId(s.url) === sourceId)
  const domain = sourceEntry ? (() => { try { return new URL(sourceEntry.url).hostname } catch { return sourceId } })() : sourceId
  const base = new URL(reqUrl).origin

  const rssItems = items.map(m => `
    <item>
      <title>${xmlAttr(m.fromTitle || m.fromPost)}</title>
      <link>${xmlAttr(m.fromPost)}</link>
      <guid>${xmlAttr(m.fromPost)}</guid>
      <pubDate>${new Date(m.fromDate || m.foundAt).toUTCString()}</pubDate>
      <description><![CDATA[<p>↩ <a href="${m.fromSource}">${xmlAttr((() => { try { return new URL(m.fromSource).hostname } catch { return m.fromSource } })())}</a> mentioned <a href="${m.toUrl}">${xmlAttr(domain)}</a> in this post:</p>${m.fromContent || ''}]]></description>
    </item>`).join('')

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Mentions of ${xmlAttr(domain)} · discover</title>
    <description>Posts from other discover sources that linked to ${xmlAttr(domain)}</description>
    <link>${base}/api/mentions/${sourceId}.xml</link>
    ${rssItems}
  </channel>
</rss>`

  return new Response(xml, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }
  })
}

// GET /api/discover/admin/webping — find posts in dataset that link to other sources in dataset
const handleWebping = async (kv) => {
  const [feeds, sourceIndex] = await Promise.all([getFeeds(kv) || [], getSourceIndex(kv)])

  const sourceDomains = new Map() // hostname → source url
  for (const entry of Object.values(sourceIndex)) {
    try { sourceDomains.set(new URL(entry.url).hostname, entry.url) } catch {}
  }

  const allSourceUrls = [...new Set(feeds.flatMap(f => f.sources || []))]
  const sourceDatas = await Promise.all(allSourceUrls.map(u => getSourceData(kv, u)))

  const matches = []
  for (let i = 0; i < allSourceUrls.length; i++) {
    const data = sourceDatas[i]
    if (!data?.posts) continue
    const fromDomain = (() => { try { return new URL(allSourceUrls[i]).hostname } catch { return null } })()
    for (const post of data.posts) {
      if (!post.content) continue
      const hrefs = [...post.content.matchAll(/href=["']([^"']+)["']/g)].map(m => m[1])
      for (const href of hrefs) {
        try {
          const domain = new URL(href).hostname
          if (domain === fromDomain) continue
          if (VIDEO_DOMAINS.has(domain)) continue
          if (sourceDomains.has(domain)) {
            matches.push({ from: allSourceUrls[i], post: post.url, postTitle: post.title, linksTo: href, targetSource: sourceDomains.get(domain) })
          }
        } catch {}
      }
    }
  }

  return json({ sources: allSourceUrls.length, matches })
}

// GET /api/discover/all/opml — full OPML of every approved playlist's sources
const handleAllOpml = async (kv) => {
  const feeds = await getFeeds(kv) || []
  return new Response(toOpml(feeds), {
    headers: {
      'Content-Type': 'text/x-opml',
      'Content-Disposition': 'attachment; filename="discover-all.opml"'
    }
  })
}

// GET /api/discover/admin/curate
const handleCurateGet = async (kv) => {
  const [pending, candidates, trending] = await Promise.all([
    getPending(kv),
    kv.get('discover:curate-candidates', { type: 'json' }),
    kv.get('discover:trending-domains', { type: 'json' })
  ])
  return json({ pending: pending || [], candidates: candidates || [], trending: trending || [] })
}

// POST /api/discover/admin/curate/approve — move candidate to pending
const handleCurateApprove = async (req, kv) => {
  const body = await parseJsonBody(req)
  if (!body?.domain || !body?.feedUrl) return json({ error: 'domain and feedUrl required' }, 400)
  const [pending, candidates] = await Promise.all([getPending(kv), kv.get('discover:curate-candidates', { type: 'json' })])
  const pendingList = pending || []
  if (!pendingList.find(p => p.url === body.feedUrl)) {
    pendingList.push({ url: body.feedUrl, title: body.domain, description: '', submittedAt: new Date().toISOString() })
  }
  await Promise.all([
    kv.put(KV_PENDING, JSON.stringify(pendingList)),
    kv.put('discover:curate-candidates', JSON.stringify((candidates || []).filter(c => c.domain !== body.domain)))
  ])
  return json({ ok: true })
}

// DELETE /api/discover/admin/curate/candidate
const handleCurateDismissCandidate = async (req, kv) => {
  const body = await parseJsonBody(req)
  if (!body?.domain) return json({ error: 'domain required' }, 400)
  const [candidates, dismissed] = await Promise.all([
    kv.get('discover:curate-candidates', { type: 'json' }),
    kv.get('discover:dismissed-domains', { type: 'json' })
  ])
  await Promise.all([
    kv.put('discover:curate-candidates', JSON.stringify((candidates || []).filter(c => c.domain !== body.domain))),
    kv.put('discover:dismissed-domains', JSON.stringify([...new Set([...(dismissed || []), body.domain])]))
  ])
  return json({ ok: true })
}

// DELETE /api/discover/admin/curate/trending
const handleCurateDismissTrending = async (req, kv) => {
  const body = await parseJsonBody(req)
  if (!body?.domain) return json({ error: 'domain required' }, 400)
  const [trending, dismissed] = await Promise.all([
    kv.get('discover:trending-domains', { type: 'json' }),
    kv.get('discover:dismissed-domains', { type: 'json' })
  ])
  await Promise.all([
    kv.put('discover:trending-domains', JSON.stringify((trending || []).filter(t => t.domain !== body.domain))),
    kv.put('discover:dismissed-domains', JSON.stringify([...new Set([...(dismissed || []), body.domain])]))
  ])
  return json({ ok: true })
}

// router

export const handleDiscover = async (req, env) => {
  const url = new URL(req.url)
  const path = url.pathname
  const method = req.method
  const kv = env.DISCOVER_KV

  // Public routes — no auth
  if (method === 'GET' && path === '/api/discover') return handleList(kv, url)
  if (method === 'POST' && path === '/api/discover/feed') return handleFeed(kv, req)
  if (method === 'POST' && path === '/api/discover/feed/opml') return handleFeedOpml(kv, req)
  if (method === 'GET' && path === '/api/discover/all/opml') return handleAllOpml(kv)
  if (method === 'GET' && path === '/api/discover/random') return handleRandom(kv, url)
  if (method === 'GET' && path === '/api/discover/new') return handleNew(kv)
  if (method === 'POST' && path === '/api/discover/preview') return handlePreview(req, kv)
  if (method === 'POST' && path === '/api/discover/submit') return handleSubmit(req, kv)

  // /:id routes
  const idMatch = path.match(/^\/api\/discover\/([^/]+)$/)
  if (idMatch) {
    const id = idMatch[1]
    if (method === 'GET') return handlePlaylist(kv, id)
    if (method === 'POST') return handleImport(kv, id)
  }

  const opmlMatch = path.match(/^\/api\/discover\/([^/]+)\/opml$/)
  if (opmlMatch && method === 'GET') return handleOpml(kv, opmlMatch[1])

  const rssMatch = path.match(/^\/api\/discover\/([^/]+)\/rss$/)
  if (rssMatch && method === 'GET') return handlePlaylistRss(kv, rssMatch[1], req.url)

  // Admin routes — owner or curator
  const token = req.headers?.get('authorization')?.replace('Bearer ', '')
  const pubkey = await memberByToken(token, kv)
  if (!pubkey) return json({ error: 'unauthorized' }, 401)
  const isOwner = isOwnerPubkey(pubkey, env)
  const curator = !isOwner ? await getCurator(kv, pubkey) : null
  if (!isOwner && !curator) return json({ error: 'unauthorized' }, 401)

  if (curator && shouldUpdateLastSeen(curator)) {
    await saveCurator(kv, pubkey, { ...curator, lastSeen: new Date().toISOString() })
  }

  // Routes accessible to curators (own playlist only)
  const playlistSourceMatch = path.match(/^\/api\/discover\/admin\/([^/]+)\/sources$/)
  if (playlistSourceMatch) {
    const id = playlistSourceMatch[1]
    if (!isOwner && !isCuratorOf(curator, id)) return json({ error: 'unauthorized' }, 401)
    if (method === 'POST') return handlePlaylistSourceAdd(req, kv, id)
    if (method === 'DELETE') return handlePlaylistSourceRemove(req, kv, id)
  }

  const playlistRefreshMatch = path.match(/^\/api\/discover\/admin\/([^/]+)\/refresh$/)
  if (playlistRefreshMatch && method === 'POST') {
    const id = playlistRefreshMatch[1]
    if (!isOwner && !isCuratorOf(curator, id)) return json({ error: 'unauthorized' }, 401)
    return handlePlaylistRefresh(kv, id)
  }

  // Specific PATCH/DELETE paths that would otherwise match the /admin/:id playlist catch-all
  if (path === '/api/discover/admin/source') {
    if (!isOwner) return json({ error: 'unauthorized' }, 401)
    if (method === 'PATCH') return handleSourceEdit(req, kv)
    if (method === 'DELETE') return handleSourceDelete(req, kv)
  }
  if (method === 'DELETE' && path === '/api/discover/admin/pending') {
    if (!isOwner) return json({ error: 'unauthorized' }, 401)
    return handlePendingReject(req, kv)
  }

  // Catch-all for playlist PATCH/DELETE — specific paths above must come first
  const adminIdMatch = path.match(/^\/api\/discover\/admin\/([^/]+)$/)
  if (adminIdMatch) {
    const id = adminIdMatch[1]
    if (method === 'PATCH') {
      if (!isOwner && !isCuratorOf(curator, id)) return json({ error: 'unauthorized' }, 401)
      return handleEdit(req, kv, id)
    }
    if (method === 'DELETE') {
      if (!isOwner) return json({ error: 'unauthorized' }, 401)
      return handleDelete(kv, id)
    }
  }

  // Owner-only routes
  if (!isOwner) return json({ error: 'unauthorized' }, 401)

  if (method === 'GET' && path === '/api/discover/admin/curate') return handleCurateGet(kv)
  if (method === 'POST' && path === '/api/discover/admin/curate/approve') return handleCurateApprove(req, kv)
  if (method === 'DELETE' && path === '/api/discover/admin/curate/candidate') return handleCurateDismissCandidate(req, kv)
  if (method === 'DELETE' && path === '/api/discover/admin/curate/trending') return handleCurateDismissTrending(req, kv)

  if (method === 'GET' && path === '/api/discover/admin/status') {
    const lastCronOk = await kv.get('cron:lastOk')
    return json({ lastCronOk })
  }

  if (method === 'GET' && path === '/api/discover/admin/webping') return handleWebping(kv)
  if (method === 'GET' && path === '/api/discover/admin/feeds') {
    const feeds = await getFeeds(kv) || []
    return json({ feeds, tags: computeTags(feeds) })
  }
  if (method === 'GET' && path === '/api/discover/admin/sources') {
    const index = await getSourceIndex(kv)
    return json(Object.values(index))
  }
  if (method === 'GET' && path === '/api/discover/admin/pending') return handlePendingList(kv)
  if (method === 'POST' && path === '/api/discover/admin/validate') return handleValidate(req, kv)
  if (method === 'POST' && path === '/api/discover/admin/approve') return handleApprove(req, kv)
  if (method === 'POST' && path === '/api/discover/admin/add') return handleAdd(req, kv)
  if (method === 'POST' && path === '/api/discover/admin/source') return handleSourceRegister(req, kv)

  if (method === 'GET' && path === '/api/discover/admin/blocked') return handleBlockedList(kv)
  if (method === 'PUT' && path === '/api/discover/admin/blocked') return handleBlockedSave(req, kv)
  if (method === 'POST' && path === '/api/discover/admin/build-curate-candidates') {
    const [sourceIndex, sourceAll, feeds] = await Promise.all([getSourceIndex(kv), kv.get('source:all', { type: 'json' }), getFeeds(kv)])
    const allSourceUrls = [...new Set((feeds || []).flatMap(f => f.sources || []))]
    const src = sourceAll || {}
    const freshData = new Map(allSourceUrls.map(u => [u, src[makeId(u)]]).filter(([, d]) => d))
    await buildCurateCandidates(kv, sourceIndex, freshData)
    return json({ ok: true, sources: freshData.size })
  }
  if (method === 'POST' && path === '/api/discover/admin/build-link-graph') {
    const [sourceIndex, sourceAll, feeds] = await Promise.all([getSourceIndex(kv), kv.get('source:all', { type: 'json' }), getFeeds(kv)])
    const allSourceUrls = [...new Set((feeds || []).flatMap(f => f.sources || []))]
    const src = sourceAll || {}
    const freshData = new Map(allSourceUrls.map(u => [u, src[makeId(u)]]).filter(([, d]) => d))
    await buildLinkGraph(kv, sourceIndex, freshData)
    return json({ ok: true, sources: freshData.size })
  }
  if (method === 'POST' && path === '/api/discover/admin/check') {
    const body = await req.json().catch(() => ({}))
    const result = await checkDiscoverFeeds(env, { force: !!body.force })
    return json({ ok: true, ...result })
  }
  if (method === 'POST' && path === '/api/discover/admin/normalize-urls') {
    const norm = u => u.replace(/\/+$/, '')
    const [feeds, index] = await Promise.all([getFeeds(kv) || [], getSourceIndex(kv)])
    const ops = []
    for (const feed of feeds) {
      const clean = (feed.sources || []).map(norm)
      if (clean.join() !== (feed.sources || []).join()) { feed.sources = clean; ops.push(saveFeed(kv, feed)) }
    }
    for (const [hash, entry] of Object.entries(index)) {
      const clean = norm(entry.url)
      if (clean !== entry.url) {
        const newHash = makeId(clean)
        delete index[hash]
        index[newHash] = { ...entry, url: clean }
      }
    }
    ops.push(kv.put(KV_SOURCE_INDEX, JSON.stringify(index)))
    await Promise.all(ops)
    return json({ ok: true, updated: ops.length - 1 })
  }
  if (method === 'POST' && path === '/api/discover/admin/reset-streaks') {
    const feeds = await getFeeds(kv) || []
    feeds.forEach(f => { f.failStreak = 0; f.lastChecked = null; f.active = true })
    await Promise.all(feeds.map(f => saveFeed(kv, f)))
    return json({ ok: true, reset: feeds.length })
  }

  // Curator management
  if (method === 'GET' && path === '/api/discover/admin/curator') return handleCuratorList(kv)
  if (method === 'POST' && path === '/api/discover/admin/curator/invite') return handleCuratorInvite(req, kv)
  const curatorPubkeyMatch = path.match(/^\/api\/discover\/admin\/curator\/([^/]+)$/)
  if (curatorPubkeyMatch && method === 'DELETE') return handleCuratorRevoke(kv, curatorPubkeyMatch[1])

  // Backup download
  if (method === 'GET' && path === '/api/discover/admin/backup') {
    const [feeds, blocked] = await Promise.all([getFeeds(kv), getBlocked(kv)])
    const date = new Date().toISOString().slice(0, 10)
    return new Response(JSON.stringify({ date, feeds: feeds || [], blocked: blocked || [] }, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="discover-backup-${date}.json"`
      }
    })
  }

  return json({ error: 'not found' }, 404)
}

// Personal feed slug — admin GET/PUT + user feed PUT
export const handleUserFeed = async (req, env) => {
  const kv = env.DISCOVER_KV
  const path = new URL(req.url).pathname
  const method = req.method

  const authed = async () => {
    const token = req.headers?.get('authorization')?.replace('Bearer ', '')
    const pubkey = await memberByToken(token, kv)
    return isOwnerPubkey(pubkey, env)
  }

  if (path === '/api/feed/admin/slug') {
    if (!await authed()) return json({ error: 'unauthorized' }, 401)
    if (method === 'GET') {
      const slug = await getUserFeedSlug(kv)
      return json({ slug: slug || null })
    }
    if (method === 'PUT') {
      const body = await parseJsonBody(req)
      const slug = String(body?.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40)
      if (!slug) return json({ error: 'invalid slug' }, 400)
      await setUserFeedSlug(kv, slug)
      return json({ ok: true, slug })
    }
  }

  const slugMatch = path.match(/^\/api\/feed\/([^/]+)$/)
  if (slugMatch && method === 'PUT') {
    if (!await authed()) return json({ error: 'unauthorized' }, 401)
    const body = await parseJsonBody(req)
    if (!body) return json({ error: 'invalid json' }, 400)
    const { ids = [], sources = [], customFeeds = [] } = body
    await setUserFeed(kv, slugMatch[1], { ids, sources, customFeeds })
    return json({ ok: true })
  }

  return json({ error: 'not found' }, 404)
}

// Personal RSS feed — public, built from stored follows
export const handlePersonalRss = async (req, env, slug) => {
  const kv = env.DISCOVER_KV
  const data = await getUserFeed(kv, slug)
  if (!data) return new Response('Not found', { status: 404 })

  const { ids = [], sources: sourcesParam = [] } = data
  const feeds = (await Promise.all(ids.map(id => getFeed(kv, id)))).filter(Boolean)
  const allSourceUrls = [...new Set([...feeds.flatMap(f => f.sources || []), ...sourcesParam])]

  const sourceAll = await resolveSourceAll(kv, allSourceUrls)

  const seen = new Set()
  const posts = allSourceUrls
    .map(u => sourceAll[makeId(u)])
    .filter(Boolean)
    .flatMap(s => s.posts || [])
    .filter(p => { if (!p.url || seen.has(p.url)) return false; seen.add(p.url); return true })
    .sort((a, b) => new Date(b.date) - new Date(a.date))

  const base = new URL(req.url).origin
  const items = posts.map(p => `
    <item>
      <title>${xmlAttr(p.title)}</title>
      <link>${xmlAttr(p.url)}</link>
      <guid>${xmlAttr(p.url)}</guid>
      ${p.date ? `<pubDate>${new Date(p.date).toUTCString()}</pubDate>` : ''}
      ${p.author || p.feed?.title ? `<author>${xmlAttr(p.author || p.feed?.title)}</author>` : ''}
      ${p.feed?.title ? `<source url="${xmlAttr(p.feed?.url || '')}">${xmlAttr(p.feed.title)}</source>` : ''}
      ${p.content ? `<description><![CDATA[${p.content}]]></description>` : ''}
    </item>`).join('')

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${xmlAttr(slug)}'s feed · discover</title>
    <description>Personal RSS feed from discover</description>
    <link>${base}/feed</link>
    ${items}
  </channel>
</rss>`

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=900'
    }
  })
}
