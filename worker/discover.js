import { memberByToken, isOwnerPubkey } from './auth.js'
import { json, parseJsonBody, isClickThrough } from './utils.js'
import {
  makeId, computeTags,
  getFeed, saveFeed, getFeeds,
  getSourceData, saveSourceData, getSourceAllData,
  getFilteredFeeds, getTagCounts, hasNewSources, getSourceMentionCounts,
  getNewestSourcePosts, getRandomSourcePosts, searchSources,
  isFeedSource, isBlocked, getAllSourceUrls, getStaleSourceMeta,
  isCuratorOf, shouldUpdateLastSeen,
  getCurator, saveCurator,
  getPending, savePending, getBlocked,
  getUserFeedSlug, setUserFeedSlug, getUserFeed, setUserFeed,
  getMentions, getCronState
} from './discover-db.js'
import { checkDiscoverFeeds, computeFrequency, fetchSource, findImage, buildLinkGraph, buildCurateCandidates } from './discover-cron.js'
import {
  handleCuratorList, handleCuratorInvite, handleCuratorRevoke,
  handleValidate, handlePendingReject, handlePendingList, handleApprove,
  handleAdd, handleEdit, handleDelete,
  handleSourceRefresh, handleSourceRegister,
  handlePlaylistSourceAdd, handlePlaylistRefresh, handlePlaylistSourceRemove,
  handleSourceEdit, handleSourceDelete,
  handleBlockedList, handleBlockedSave,
  handleWebping,
  handleCurateGet, handleCurateApprove, handleCurateDismissCandidate
} from './discover-admin.js'

// re-export for worker/index.js and tests
export { checkDiscoverFeeds, computeFrequency, makeId, computeTags }

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

// GET /api/discover
const handleList = async (db, url) => {
  const TWO_WEEKS_ISO = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
  const tag = url.searchParams.get('tag') || undefined
  const q = url.searchParams.get('q') || undefined
  const cursor = url.searchParams.get('cursor') || undefined
  const limit = 50

  const [{ feeds, cursor: nextCursor }, tags, hasNew, mentionCounts] = await Promise.all([
    getFilteredFeeds(db, { tag, q, limit, cursor }),
    getTagCounts(db),
    hasNewSources(db, TWO_WEEKS_ISO),
    getSourceMentionCounts(db)
  ])

  const stripped = feeds.map(({ previewPosts, ...f }) => f)
  const body = JSON.stringify({ feeds: stripped, tags, hasNew, mentionCounts, cursor: nextCursor })
  const headers = { 'Content-Type': 'application/json' }
  if (!tag && !q && !cursor) headers['Cache-Control'] = 'public, max-age=1800'
  return cors(new Response(body, { headers }))
}

// GET /api/discover/:id
const handlePlaylist = async (db, id) => {
  const entry = await getFeed(db, id)
  if (!entry) return json({ error: 'not found' }, 404)
  const posts = entry.previewPosts || []
  return cors(new Response(JSON.stringify(posts), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }
  }))
}

// GET /api/discover/:id/rss
const handlePlaylistRss = async (db, id, reqUrl) => {
  const entry = await getFeed(db, id)
  if (!entry) return json({ error: 'not found' }, 404)

  const sourceDatas = await Promise.all((entry.sources || []).map(url => getSourceData(db, url)))
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
      'Cache-Control': 'no-store'
    }
  })
}

// GET /api/discover/:id/opml
const handleOpml = async (db, id) => {
  let entry
  if (id === 'all') {
    const feeds = await getFeeds(db) || []
    entry = { title: 'discover', sources: feeds.flatMap(f => f.sources || []) }
  } else {
    entry = await getFeed(db, id)
  }
  if (!entry) return json({ error: 'not found' }, 404)

  return new Response(toOpml([entry]), {
    headers: {
      'Content-Type': 'text/x-opml',
      'Content-Disposition': `attachment; filename="discover-${id}.opml"`
    }
  })
}

// Resolve source data for a list of URLs from D1, live-fetch anything missing.
const resolveSourceAll = async (db, allSourceUrls) => {
  const sourceAll = await getSourceAllData(db, allSourceUrls)

  const stillMissing = allSourceUrls.filter(u => !sourceAll[makeId(u)])
  for (const url of stillMissing) {
    const result = await fetchSource(url, 3)
    if (!result.posts?.length) continue
    const posts = result.posts.slice(0, 3).map(p => ({
      title: p.title, url: p.url, date: p.date, author: p.author, feed: p.feed, content: p.content
    }))
    const data = { url, posts, image: findImage(result.posts) || null, siteUrl: result.siteUrl || null }
    sourceAll[makeId(url)] = data
    await saveSourceData(db, url, { ...data, statusCode: result.statusCode, error: null, lastFetched: new Date().toISOString() })
  }

  return sourceAll
}

// POST /api/discover/feed
const handleFeed = async (db, req) => {
  const body = await parseJsonBody(req)
  const ids = Array.isArray(body?.ids) ? body.ids.filter(Boolean) : []
  const sourceUrls = Array.isArray(body?.sources) ? body.sources.filter(Boolean) : []
  if (!ids.length && !sourceUrls.length) return cors(json({ posts: [] }))

  const feeds = (await Promise.all(ids.map(id => getFeed(db, id)))).filter(Boolean)
  const allSourceUrls = [...new Set([...feeds.flatMap(f => f.sources || []), ...sourceUrls])]

  const sourceDatas = await Promise.all(allSourceUrls.map(u => getSourceData(db, u)))

  const seen = new Set()
  const posts = sourceDatas
    .filter(Boolean)
    .flatMap(s => s.posts || [])
    .filter(p => { if (!p.url || seen.has(p.url)) return false; seen.add(p.url); return true })
    .sort((a, b) => new Date(b.date) - new Date(a.date))

  return cors(json({ posts }))
}

// POST /api/discover/feed/opml
const handleFeedOpml = async (db, req) => {
  const { ids = [], sources = [] } = await req.json().catch(() => ({}))
  const feeds = ids.length ? (await Promise.all(ids.map(id => getFeed(db, id)))).filter(Boolean) : []
  if (sources.length) feeds.push({ title: 'followed sources', sources })
  return new Response(toOpml(feeds), {
    headers: {
      'Content-Type': 'text/x-opml',
      'Content-Disposition': 'attachment; filename="feed.opml"'
    }
  })
}

// GET /api/discover/random
const handleRandom = async (db) => {
  const sources = await getRandomSourcePosts(db)
  const seen = new Set()
  const all = sources
    .flatMap(s => (s.posts || []).map(p => ({ ...p, fromPlaylist: s.playlist.title, fromPlaylistId: s.playlist.id })))
    .filter(p => p?.url && !seen.has(p.url) && seen.add(p.url))
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]]
  }
  return cors(json(all.slice(0, 100)))
}

// GET /api/discover/new
const handleNew = async (db) => {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const sources = await getNewestSourcePosts(db)
  const seen = new Set()
  const posts = sources
    .flatMap(s => (s.posts || []).map(p => ({ ...p, fromPlaylist: s.playlist.title, fromPlaylistId: s.playlist.id })))
    .filter(p => p?.url && p?.date && p.date >= cutoff && !seen.has(p.url) && seen.add(p.url))
    .sort((a, b) => new Date(b.date) - new Date(a.date))
  return cors(json(posts))
}

// POST /api/discover/preview
const handlePreview = async (req, db) => {
  const origin = req.headers.get('origin') || ''
  const host = new URL(req.url).host
  let originHost; try { originHost = new URL(origin).host } catch { originHost = '' }
  if (originHost !== host) return json({ error: 'forbidden' }, 403)
  const body = await parseJsonBody(req)
  if (!body) return json({ error: 'invalid json' }, 400)
  const url = body.url?.trim().replace(/\/+$/, '')
  if (!url) return json({ error: 'url required' }, 400)
  if (!URL.canParse(url)) return json({ error: 'invalid url' }, 400)

  const parsed = new URL(url)
  if (parsed.host === host) {
    const mentionsMatch = parsed.pathname.match(/^\/api\/mentions\/([^/]+)\.xml$/)
    if (mentionsMatch) {
      const mentions = await getMentions(db, mentionsMatch[1])
      const posts = mentions.slice(0, 2).map(m => ({ title: m.fromTitle || m.fromPost, url: m.fromPost, date: m.fromDate, feed: { title: `mentions · ${mentionsMatch[1]}` } }))
      return cors(json({ title: `mentions · ${mentionsMatch[1]}`, image: null, posts, siteUrl: null }))
    }
    const rssMatch = parsed.pathname.match(/^\/api\/discover\/([^/]+)\/rss$/)
    if (!rssMatch) return cors(json({ error: 'use the follow button on the discover page instead' }, 422))
    const feed = await getFeed(db, rssMatch[1])
    if (!feed) return cors(json({ error: 'playlist not found' }, 422))
    const sourceDatas = await Promise.all((feed.sources || []).map(u => getSourceData(db, u)))
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
const handleSubmit = async (req, db) => {
  const body = await parseJsonBody(req)
  if (!body) return json({ error: 'invalid json' }, 400)

  const url = body.url?.trim().replace(/\/+$/, '')
  if (!url) return json({ error: 'url required' }, 400)
  if (!URL.canParse(url)) return json({ error: 'invalid url' }, 400)

  const ok = json({ ok: true })

  if (await isBlocked(db, [url])) return ok

  const [alreadySource, pending] = await Promise.all([isFeedSource(db, url), getPending(db)])
  if (alreadySource) return ok
  if ((pending || []).some(f => f.url === url)) return ok

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
  await savePending(db, [...pending, item])
  return ok
}

// POST /api/discover/:id/import
const handleImport = async (db, id) => {
  const feed = await getFeed(db, id)
  if (!feed) return json({ error: 'not found' }, 404)
  feed.imports = (feed.imports || 0) + 1
  await saveFeed(db, feed)
  return json({ ok: true })
}

// GET /api/discover/all/opml
const handleAllOpml = async (db) => {
  const feeds = await getFeeds(db) || []
  return new Response(toOpml(feeds), {
    headers: {
      'Content-Type': 'text/x-opml',
      'Content-Disposition': 'attachment; filename="discover-all.opml"'
    }
  })
}

// router

export const handleDiscover = async (req, env, ctx) => {
  const url = new URL(req.url)
  const path = url.pathname
  const method = req.method
  const db = env.DISCOVER_DB

  // Public routes — no auth
  if (method === 'GET' && path === '/api/discover') return handleList(db, url)
  if (method === 'POST' && path === '/api/discover/feed') return handleFeed(db, req)
  if (method === 'POST' && path === '/api/discover/feed/opml') return handleFeedOpml(db, req)
  if (method === 'GET' && path === '/api/discover/all/opml') return handleAllOpml(db)
  if (method === 'GET' && path === '/api/discover/random') return handleRandom(db)
  if (method === 'GET' && path === '/api/discover/new') return handleNew(db)
  if (method === 'POST' && path === '/api/discover/preview') return handlePreview(req, db)
  if (method === 'POST' && path === '/api/discover/submit') return handleSubmit(req, db)
  if (method === 'GET' && path === '/api/discover/search') {
    const q = url.searchParams.get('q')?.trim()
    const tag = url.searchParams.get('tag') || undefined
    return cors(json(await searchSources(db, { q, tag })))
  }

  // /:id routes
  const idMatch = path.match(/^\/api\/discover\/([^/]+)$/)
  if (idMatch) {
    const id = idMatch[1]
    if (method === 'GET') return handlePlaylist(db, id)
    if (method === 'POST') return handleImport(db, id)
  }

  const opmlMatch = path.match(/^\/api\/discover\/([^/]+)\/opml$/)
  if (opmlMatch && method === 'GET') return handleOpml(db, opmlMatch[1])

  const rssMatch = path.match(/^\/api\/discover\/([^/]+)\/rss$/)
  if (rssMatch && method === 'GET') return handlePlaylistRss(db, rssMatch[1], req.url)

  // Admin routes — owner or curator
  const token = req.headers?.get('authorization')?.replace('Bearer ', '')
  const pubkey = await memberByToken(token, db)
  if (!pubkey) return json({ error: 'unauthorized' }, 401)
  const isOwner = isOwnerPubkey(pubkey, env)
  const curator = !isOwner ? await getCurator(db, pubkey) : null
  if (!isOwner && !curator) return json({ error: 'unauthorized' }, 401)

  if (curator && shouldUpdateLastSeen(curator)) {
    await saveCurator(db, pubkey, { ...curator, lastSeen: new Date().toISOString() })
  }

  // Routes accessible to curators (own playlist only)
  const playlistSourceMatch = path.match(/^\/api\/discover\/admin\/([^/]+)\/sources$/)
  if (playlistSourceMatch) {
    const id = playlistSourceMatch[1]
    if (!isOwner && !isCuratorOf(curator, id)) return json({ error: 'unauthorized' }, 401)
    if (method === 'POST') return handlePlaylistSourceAdd(req, db, id)
    if (method === 'DELETE') return handlePlaylistSourceRemove(req, db, id)
  }

  if (method === 'POST' && path === '/api/discover/admin/source/refresh') {
    if (!isOwner) return json({ error: 'unauthorized' }, 401)
    return handleSourceRefresh(req, db)
  }

  const playlistRefreshMatch = path.match(/^\/api\/discover\/admin\/([^/]+)\/refresh$/)
  if (playlistRefreshMatch && method === 'POST') {
    const id = playlistRefreshMatch[1]
    if (!isOwner && !isCuratorOf(curator, id)) return json({ error: 'unauthorized' }, 401)
    return handlePlaylistRefresh(db, id)
  }

  // Specific PATCH/DELETE paths that would otherwise match the /admin/:id playlist catch-all
  if (path === '/api/discover/admin/source') {
    if (!isOwner) return json({ error: 'unauthorized' }, 401)
    if (method === 'PATCH') return handleSourceEdit(req, db)
    if (method === 'DELETE') return handleSourceDelete(req, db)
  }
  if (method === 'DELETE' && path === '/api/discover/admin/pending') {
    if (!isOwner) return json({ error: 'unauthorized' }, 401)
    return handlePendingReject(req, db)
  }

  // Catch-all for playlist PATCH/DELETE — specific paths above must come first
  const adminIdMatch = path.match(/^\/api\/discover\/admin\/([^/]+)$/)
  if (adminIdMatch) {
    const id = adminIdMatch[1]
    if (method === 'PATCH') {
      if (!isOwner && !isCuratorOf(curator, id)) return json({ error: 'unauthorized' }, 401)
      return handleEdit(req, db, id)
    }
    if (method === 'DELETE') {
      if (!isOwner) return json({ error: 'unauthorized' }, 401)
      return handleDelete(db, id)
    }
  }

  // Owner-only routes
  if (!isOwner) return json({ error: 'unauthorized' }, 401)

  if (method === 'GET' && path === '/api/discover/admin/curate') return handleCurateGet(db)
  if (method === 'POST' && path === '/api/discover/admin/curate/approve') return handleCurateApprove(req, db)
  if (method === 'DELETE' && path === '/api/discover/admin/curate/candidate') return handleCurateDismissCandidate(req, db)

  if (method === 'GET' && path === '/api/discover/admin/status') {
    const [lastCronOk, lastCronCount] = await Promise.all([
      getCronState(db, 'cron:lastOk'),
      getCronState(db, 'cron:lastCount')
    ])
    return json({ lastCronOk, lastCronCount: lastCronCount ? parseInt(lastCronCount) : null })
  }

  if (method === 'GET' && path === '/api/discover/admin/webping') return handleWebping(db)
  if (method === 'GET' && path === '/api/discover/admin/feeds') {
    const feeds = await getFeeds(db) || []
    return json({ feeds, tags: computeTags(feeds) })
  }
  if (method === 'GET' && path === '/api/discover/admin/sources') {
    return json(await getStaleSourceMeta(db))
  }
  if (method === 'GET' && path === '/api/discover/admin/pending') return handlePendingList(db)
  if (method === 'POST' && path === '/api/discover/admin/validate') return handleValidate(req, db)
  if (method === 'POST' && path === '/api/discover/admin/approve') return handleApprove(req, db)
  if (method === 'POST' && path === '/api/discover/admin/add') return handleAdd(req, db)
  if (method === 'POST' && path === '/api/discover/admin/source') return handleSourceRegister(req, db)

  if (method === 'GET' && path === '/api/discover/admin/blocked') return handleBlockedList(db)
  if (method === 'PUT' && path === '/api/discover/admin/blocked') return handleBlockedSave(req, db)

  if (method === 'POST' && path === '/api/discover/admin/build-link-graph') {
    const sourceUrls = await getAllSourceUrls(db)
    const sourceAll = await resolveSourceAll(db, sourceUrls)
    const freshData = new Map(sourceUrls.map(u => [u, sourceAll[makeId(u)]]).filter(([, d]) => d))
    await buildLinkGraph(db, sourceUrls, freshData)
    await buildCurateCandidates(db, sourceUrls, freshData)
    return json({ ok: true, sources: freshData.size })
  }
  if (method === 'POST' && path === '/api/discover/admin/check') {
    ctx.waitUntil(checkDiscoverFeeds(env).catch(err => console.error('admin check failed:', err)))
    return json({ ok: true, triggered: true })
  }
  if (method === 'POST' && path === '/api/discover/admin/normalize-urls') {
    const norm = u => u.replace(/\/+$/, '')
    const feeds = await getFeeds(db) || []
    const ops = []
    for (const feed of feeds) {
      const clean = (feed.sources || []).map(norm)
      if (clean.join() !== (feed.sources || []).join()) { feed.sources = clean; ops.push(saveFeed(db, feed)) }
    }
    await Promise.all(ops)
    return json({ ok: true, updated: ops.length })
  }
  if (method === 'POST' && path === '/api/discover/admin/reset-streaks') {
    const feeds = await getFeeds(db) || []
    feeds.forEach(f => { f.failStreak = 0; f.lastChecked = null; f.active = true })
    await Promise.all(feeds.map(f => saveFeed(db, f)))
    return json({ ok: true, reset: feeds.length })
  }

  // Curator management
  if (method === 'GET' && path === '/api/discover/admin/curator') return handleCuratorList(db)
  if (method === 'POST' && path === '/api/discover/admin/curator/invite') return handleCuratorInvite(req, db)
  const curatorPubkeyMatch = path.match(/^\/api\/discover\/admin\/curator\/([^/]+)$/)
  if (curatorPubkeyMatch && method === 'DELETE') return handleCuratorRevoke(db, curatorPubkeyMatch[1])

  // Backup download
  if (method === 'GET' && path === '/api/discover/admin/backup') {
    const [feeds, blocked] = await Promise.all([getFeeds(db), getBlocked(db)])
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

// GET /api/mentions/:sourceId.xml
export const handleMentionsFeed = async (db, sourceId, reqUrl) => {
  const items = await getMentions(db, sourceId)
  const domain = sourceId
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
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'no-store' }
  })
}

// Personal feed slug — admin GET/PUT + user feed PUT
export const handleUserFeed = async (req, env) => {
  const db = env.DISCOVER_DB
  const path = new URL(req.url).pathname
  const method = req.method

  const authed = async () => {
    const token = req.headers?.get('authorization')?.replace('Bearer ', '')
    const pubkey = await memberByToken(token, db)
    return isOwnerPubkey(pubkey, env)
  }

  if (path === '/api/feed/admin/slug') {
    if (!await authed()) return json({ error: 'unauthorized' }, 401)
    if (method === 'GET') {
      const slug = await getUserFeedSlug(db)
      return json({ slug: slug || null })
    }
    if (method === 'PUT') {
      const body = await parseJsonBody(req)
      const slug = String(body?.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40)
      if (!slug) return json({ error: 'invalid slug' }, 400)
      await setUserFeedSlug(db, slug)
      return json({ ok: true, slug })
    }
  }

  const slugMatch = path.match(/^\/api\/feed\/([^/]+)$/)
  if (slugMatch && method === 'PUT') {
    if (!await authed()) return json({ error: 'unauthorized' }, 401)
    const body = await parseJsonBody(req)
    if (!body) return json({ error: 'invalid json' }, 400)
    const { ids = [], sources = [], customFeeds = [] } = body
    await setUserFeed(db, slugMatch[1], { ids, sources, customFeeds })
    return json({ ok: true })
  }

  return json({ error: 'not found' }, 404)
}

// Personal RSS feed — public, built from stored follows
export const handlePersonalRss = async (req, env, slug) => {
  const db = env.DISCOVER_DB
  const data = await getUserFeed(db, slug)
  if (!data) return new Response('Not found', { status: 404 })

  const { ids = [], sources: sourcesParam = [] } = data
  const feeds = (await Promise.all(ids.map(id => getFeed(db, id)))).filter(Boolean)
  const allSourceUrls = [...new Set([...feeds.flatMap(f => f.sources || []), ...sourcesParam])]

  const sourceAll = await resolveSourceAll(db, allSourceUrls)

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
      'Cache-Control': 'no-store'
    }
  })
}
