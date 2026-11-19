import { memberByToken, isOwnerPubkey, isRateLimited, incrementAttempt } from './auth.js'
import { json, parseJsonBody, sameBlog, bareHost } from './utils.js'
import { getSourceDataBulk, getAllSourceUrls, getStaleSourceMeta, hasNewSources } from './db-sources.js'
import {
  computeTags, getFeed, getFeeds, getFilteredFeeds, getTagCounts,
  getNewestSourcePosts, getRandomSourcePosts
} from './db-feeds.js'
import { isBlocked, getPending, savePending, getBlocked } from './db-moderation.js'
import { getSourceMentionCounts } from './db-mentions.js'
import { getCronState, getRateLimit, setRateLimit } from './db-auth.js'
import { searchSources, getTagCloud, getPostsByTag } from './db-search.js'
import { checkDiscoverFeeds } from './cron.js'
import { fetchSource } from './fetch-source.js'
import { buildLinkGraph } from './link-graph.js'
import { buildCurateCandidates, REBUILD_PROBES } from './curate.js'
import { isFullText, feedStats } from './feed-stats.js'
import {
  handleValidate, handlePendingReject, handlePendingList, handleApprove,
  handleAdd, handleEdit, handleDelete,
  handleSourceRefresh, handleSourceRegister, handleSourceEdit, handleSourceDelete,
  handleBlockedList, handleBlockedSave
} from './discover-admin-sources.js'
import { handlePlaylistSourceAdd, handlePlaylistRefresh, handlePlaylistSourceRemove } from './discover-admin-playlists.js'
import { handleCurateGet, handleCurateApprove, handleCurateDismissCandidate } from './discover-admin-curate.js'
import { handleOpml, handlePlaylistRss } from './discover-opml.js'

const cors = (res) => {
  res.headers.set('Access-Control-Allow-Origin', '*')
  return res
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

// GET /api/discover/random
const handleRandom = async (db) => {
  const sources = await getRandomSourcePosts(db)
  const seen = new Set()
  const all = sources
    .flatMap(s => (s.posts || []).map(p => ({ ...p, fromPlaylist: s.playlist.title, fromPlaylistId: s.playlist.id, fromPlaylistSlug: s.playlist.slug })))
    .filter(p => p?.url && !seen.has(p.url) && seen.add(p.url))
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]]
  }
  return cors(json(all.slice(0, 100)))
}

// GET /api/discover/new?limit=20&before=<cursor>
// used to dump every post from every source in one response - 7.6MB, 2.3s,
// that's what was actually behind the "stuck loading" complaints. paginated
// now. cursor is (date, url) not an offset, so new posts landing mid-scroll
// can't shift pages around, and url breaks ties when a cron batch drops a
// bunch of posts with the same timestamp
export const handleNew = async (db, url) => {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const sources = await getNewestSourcePosts(db)
  const seen = new Set()
  const posts = sources
    .flatMap(s => (s.posts || []).map(p => ({ ...p, fromPlaylist: s.playlist.title, fromPlaylistId: s.playlist.id, fromPlaylistSlug: s.playlist.slug })))
    .filter(p => p?.url && p?.date && p.date >= cutoff && !seen.has(p.url) && seen.add(p.url))
    .sort((a, b) => new Date(b.date) - new Date(a.date) || a.url.localeCompare(b.url))

  const rawLimit = parseInt(url.searchParams.get('limit'))
  const limit = Math.min(Math.max(Number.isNaN(rawLimit) ? 20 : rawLimit, 1), 100)
  const beforeParam = url.searchParams.get('before')
  let before = null
  if (beforeParam) { try { before = JSON.parse(atob(beforeParam)) } catch {} }
  const comesAfter = (p) => p.date !== before.date ? new Date(p.date) < new Date(before.date) : p.url > before.url
  const startIdx = before ? posts.findIndex(comesAfter) : 0
  const sliceStart = startIdx === -1 ? posts.length : startIdx
  const page = posts.slice(sliceStart, sliceStart + limit)
  const last = page[page.length - 1]
  const nextCursor = page.length === limit ? btoa(JSON.stringify({ date: last.date, url: last.url })) : null
  return cors(json({ posts: page, nextCursor }))
}

// POST /api/discover/submit — public submission, no auth. Rate-limited by IP
// since this triggers a real outbound fetch regardless of whether the
// submission turns out to be a duplicate/pending/invalid feed.
const handleSubmit = async (req, db, domain) => {
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown'
  const rlKey = `ratelimit:submit:${ip}`
  const rlRecord = await getRateLimit(db, rlKey)
  if (isRateLimited(rlRecord, Date.now(), 10)) {
    return json({ error: 'too many submissions, try again later' }, 429)
  }
  await setRateLimit(db, rlKey, incrementAttempt(rlRecord, Date.now(), 60 * 60 * 1000))

  const body = await parseJsonBody(req)
  if (!body) return json({ error: 'invalid json' }, 400)

  const url = body.url?.trim().replace(/\/+$/, '')
  if (!url) return json({ error: 'url required' }, 400)
  if (url.length > 2000) return json({ error: 'url too long' }, 400)
  if (!URL.canParse(url)) return json({ error: 'invalid url' }, 400)

  const ok = json({ ok: true })

  if (await isBlocked(db, [url])) return ok

  // same blog under another feed url counts as already here
  const [sourceUrls, pending] = await Promise.all([getAllSourceUrls(db), getPending(db)])
  if (sameBlog(url, sourceUrls)) return ok
  if ((pending || []).some(f => f.url === url)) return ok

  const result = await fetchSource(url, 20, domain)
  if (!result.posts?.length) return ok
  // full text is the rule, so it's checked here too. the judgment calls
  // (pace, authors, dead) aren't - a human typed this in, a human decides
  if (!isFullText(result.posts)) return ok
  const known = new Set(sourceUrls.map(bareHost))

  const title = result.posts[0]?.feed?.title || new URL(url).hostname
  const item = {
    url,
    title: title || new URL(url).hostname,
    description: '',
    submittedAt: new Date().toISOString(),
    stats: feedStats({ ...result, feedUrl: url }, bareHost(url), known)
  }
  await savePending(db, [...pending, item])
  return ok
}

// router

export const handleDiscover = async (req, env, ctx) => {
  const url = new URL(req.url)
  const path = url.pathname
  const method = req.method
  const db = env.DISCOVER_DB

  // Public routes — no auth
  if (method === 'GET' && path === '/api/discover') return handleList(db, url)
  if (method === 'GET' && path === '/api/discover/random') return handleRandom(db)
  if (method === 'GET' && path === '/api/discover/new') return handleNew(db, url)
  if (method === 'GET' && path === '/api/discover/tags') {
    return cors(new Response(JSON.stringify(await getTagCloud(db)), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }
    }))
  }
  const tagMatch = path.match(/^\/api\/discover\/tag\/([^/]+)$/)
  if (tagMatch && method === 'GET') {
    const tag = decodeURIComponent(tagMatch[1]).toLowerCase()
    return cors(json(await getPostsByTag(db, tag)))
  }
  if (method === 'POST' && path === '/api/discover/submit') return handleSubmit(req, db, env.DOMAIN_NAME)
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
  }

  const opmlMatch = path.match(/^\/api\/discover\/([^/]+)\/opml$/)
  if (opmlMatch && method === 'GET') return handleOpml(db, opmlMatch[1], req.url)

  const rssMatch = path.match(/^\/api\/discover\/([^/]+)\/rss$/)
  if (rssMatch && method === 'GET') return handlePlaylistRss(db, rssMatch[1], req.url)

  // Admin routes - owner only. There used to be per-playlist curators too;
  // nobody was ever invited, so that whole auth path is gone.
  const token = req.headers?.get('authorization')?.replace('Bearer ', '')
  const pubkey = await memberByToken(token, db)
  if (!pubkey || !isOwnerPubkey(pubkey, env)) return json({ error: 'unauthorized' }, 401)

  const playlistSourceMatch = path.match(/^\/api\/discover\/admin\/([^/]+)\/sources$/)
  if (playlistSourceMatch) {
    const id = playlistSourceMatch[1]
    if (method === 'POST') return handlePlaylistSourceAdd(req, db, id, env.DOMAIN_NAME)
    if (method === 'DELETE') return handlePlaylistSourceRemove(req, db, id)
  }

  if (method === 'POST' && path === '/api/discover/admin/source/refresh') return handleSourceRefresh(req, db, env.DOMAIN_NAME)

  const playlistRefreshMatch = path.match(/^\/api\/discover\/admin\/([^/]+)\/refresh$/)
  if (playlistRefreshMatch && method === 'POST') {
    return handlePlaylistRefresh(db, playlistRefreshMatch[1], env.DOMAIN_NAME)
  }

  // Specific PATCH/DELETE paths that would otherwise match the /admin/:id playlist catch-all
  if (path === '/api/discover/admin/source') {
    if (method === 'PATCH') return handleSourceEdit(req, db, env.DOMAIN_NAME)
    if (method === 'DELETE') return handleSourceDelete(req, db)
  }
  if (method === 'DELETE' && path === '/api/discover/admin/pending') return handlePendingReject(req, db)

  // Catch-all for playlist PATCH/DELETE — specific paths above must come first
  const adminIdMatch = path.match(/^\/api\/discover\/admin\/([^/]+)$/)
  if (adminIdMatch) {
    const id = adminIdMatch[1]
    if (method === 'PATCH') return handleEdit(req, db, id)
    if (method === 'DELETE') return handleDelete(db, id)
  }

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

  if (method === 'GET' && path === '/api/discover/admin/feeds') {
    const feeds = await getFeeds(db) || []
    return json({ feeds, tags: computeTags(feeds) })
  }
  if (method === 'GET' && path === '/api/discover/admin/sources') {
    return json(await getStaleSourceMeta(db))
  }
  if (method === 'GET' && path === '/api/discover/admin/pending') return handlePendingList(db)
  if (method === 'POST' && path === '/api/discover/admin/validate') return handleValidate(req, db, env.DOMAIN_NAME)
  if (method === 'POST' && path === '/api/discover/admin/approve') return handleApprove(req, db)
  if (method === 'POST' && path === '/api/discover/admin/add') return handleAdd(req, db)
  if (method === 'POST' && path === '/api/discover/admin/source') return handleSourceRegister(req, db, env.DOMAIN_NAME)

  if (method === 'GET' && path === '/api/discover/admin/blocked') return handleBlockedList(db)
  if (method === 'PUT' && path === '/api/discover/admin/blocked') return handleBlockedSave(req, db)

  if (method === 'POST' && path === '/api/discover/admin/build-link-graph') {
    // stored posts only - a source the cron hasn't fetched yet waits for it
    const sourceUrls = await getAllSourceUrls(db)
    const freshData = await getSourceDataBulk(db, sourceUrls)
    await buildLinkGraph(db, sourceUrls, freshData)
    const curate = await buildCurateCandidates(db, sourceUrls, freshData, undefined, env.DOMAIN_NAME, Math.random, { probes: REBUILD_PROBES })
    return json({ ok: true, sources: freshData.size, ...curate })
  }
  if (method === 'POST' && path === '/api/discover/admin/check') {
    ctx.waitUntil(checkDiscoverFeeds(env).catch(err => console.error('admin check failed:', err)))
    return json({ ok: true, triggered: true })
  }

  // Backup download
  if (method === 'GET' && path === '/api/discover/admin/backup') {
    const [feeds, blocked, sourcesResult] = await Promise.all([
      getFeeds(db),
      getBlocked(db),
      db.prepare('SELECT * FROM sources').all()
    ])
    const date = new Date().toISOString().slice(0, 10)
    return new Response(JSON.stringify({ date, feeds: feeds || [], blocked: blocked || [], sources: sourcesResult.results || [] }, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="discover-backup-${date}.json"`
      }
    })
  }

  return json({ error: 'not found' }, 404)
}
