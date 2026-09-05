import { json, parseJsonBody, isClickThrough } from './utils.js'
import { makeId, getSourceData, deleteSourceData } from './db-sources.js'
import { getFeed, saveFeed, getFeeds, removeFromIndex, getFeedsBySourceUrl } from './db-feeds.js'
import { isBlocked, isUrlBlocked, getPending, savePending, getBlocked, saveBlocked } from './db-moderation.js'
import { deletePostTags } from './db-search.js'
import { fetchAndSaveSource, applySourceDatas, fetchSource } from './discover-cron.js'

// POST /api/discover/admin/validate — batch URL validation
export const handleValidate = async (req, db) => {
  const body = await parseJsonBody(req)
  if (!body) return json({ error: 'invalid json' }, 400)
  const urls = Array.isArray(body.urls) ? body.urls.slice(0, 20) : []
  if (!urls.length) return json({ error: 'urls required' }, 400)

  const [feeds, pending, blocked] = await Promise.all([getFeeds(db), getPending(db), getBlocked(db)])
  const allSourceUrls = new Set((feeds || []).flatMap(f => f.sources || []))
  const pendingUrls = new Set((pending || []).map(p => p.url))
  const blockedList = blocked || []

  const results = await Promise.all(urls.map(async (rawUrl) => {
    const url = rawUrl?.trim().replace(/\/+$/, '')
    if (!url || !URL.canParse(url)) return { url: rawUrl, status: 'invalid-url' }
    if (isUrlBlocked(url, blockedList)) return { url, status: 'blocked' }
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

// DELETE /api/discover/admin/pending
export const handlePendingReject = async (req, db) => {
  const body = await parseJsonBody(req)
  if (!body) return json({ error: 'invalid json' }, 400)
  const url = body.url?.trim()
  if (!url) return json({ error: 'url required' }, 400)
  const pending = await getPending(db)
  const updated = pending.filter(p => p.url !== url)
  if (updated.length === pending.length) return json({ error: 'not found' }, 404)
  await savePending(db, updated)
  return json({ ok: true })
}

// GET /api/discover/admin/pending
export const handlePendingList = async (db) => json(await getPending(db))

// POST /api/discover/admin/approve
export const handleApprove = async (req, db) => {
  const body = await parseJsonBody(req)
  if (!body) return json({ error: 'invalid json' }, 400)

  const pending = await getPending(db)
  const idx = pending.findIndex(f => f.url === body.url)
  if (idx === -1) return json({ error: 'not found' }, 404)
  const item = pending[idx]
  const remaining = pending.filter((_, i) => i !== idx)

  if (body.playlistId) {
    const feed = await getFeed(db, body.playlistId)
    if (!feed) return json({ error: 'playlist not found' }, 404)
    const sources = [...new Set([...(feed.sources || []), item.url])]
    await Promise.all([saveFeed(db, { ...feed, sources }), savePending(db, remaining)])
    return json({ ok: true })
  }

  await savePending(db, remaining)
  return json({ ok: true })
}

// POST /api/discover/admin/add
export const handleAdd = async (req, db) => {
  const body = await parseJsonBody(req)
  if (!body) return json({ error: 'invalid json' }, 400)

  const sources = Array.isArray(body.sources) ? body.sources : (body.url ? [body.url] : [])

  if (await isBlocked(db, sources)) return json({ error: 'one or more sources are not accepted' }, 403)

  const title = body.title?.trim()
  if (!title && !sources.length) return json({ error: 'title required' }, 400)
  const id = makeId(sources[0] || title)
  if (await getFeed(db, id)) return json({ error: 'already exists' }, 409)

  const entry = {
    id,
    type: sources.length > 1 ? 'playlist' : 'feed',
    title: title || new URL(sources[0]).hostname,
    description: body.description?.trim() || '',
    tags: Array.isArray(body.tags) ? body.tags.map(t => String(t).trim().toLowerCase()) : [],
    sources,
    imports: 0,
    featured: body.featured || false,
    active: true,
    updateFrequency: 'unknown',
    lastChecked: null,
    addedAt: new Date().toISOString()
  }
  await saveFeed(db, entry)
  return json({ ok: true, entry })
}

// PATCH /api/discover/admin/:id
export const handleEdit = async (req, db, id) => {
  const body = await parseJsonBody(req)
  if (!body) return json({ error: 'invalid json' }, 400)

  const feed = await getFeed(db, id)
  if (!feed) return json({ error: 'not found' }, 404)

  if (body.title !== undefined) feed.title = body.title.trim()
  if (body.description !== undefined) feed.description = body.description.trim()
  if (Array.isArray(body.tags)) feed.tags = body.tags.map(t => String(t).trim().toLowerCase())
  if (Array.isArray(body.sources)) feed.sources = body.sources
  if (body.featured !== undefined) feed.featured = !!body.featured

  await saveFeed(db, feed)
  return json({ ok: true })
}

// DELETE /api/discover/admin/:id
export const handleDelete = async (db, id) => {
  const feed = await getFeed(db, id)
  if (!feed) return json({ error: 'not found' }, 404)
  await removeFromIndex(db, id)
  return json({ ok: true })
}

// POST /api/discover/admin/source/refresh
export const handleSourceRefresh = async (req, db) => {
  const body = await parseJsonBody(req)
  const url = body?.url?.trim().replace(/\/+$/, '')
  if (!url) return json({ error: 'url required' }, 400)
  const { indexEntry } = await fetchAndSaveSource(db, url)
  return json({ ok: true, source: indexEntry })
}

// POST /api/discover/admin/source
export const handleSourceRegister = async (req, db) => {
  const body = await parseJsonBody(req)
  if (!body) return json({ error: 'invalid json' }, 400)
  const url = body.url?.trim().replace(/\/+$/, '')
  if (!url) return json({ error: 'url required' }, 400)
  if (!URL.canParse(url)) return json({ error: 'invalid url' }, 400)
  const existing = await getSourceData(db, url)
  if (existing) return json({ ok: true, existing: true })
  const { indexEntry } = await fetchAndSaveSource(db, url)
  return json({ ok: true, existing: false, source: indexEntry })
}

// PATCH /api/discover/admin/source
export const handleSourceEdit = async (req, db) => {
  const body = await parseJsonBody(req)
  if (!body) return json({ error: 'invalid json' }, 400)
  const oldUrl = body.oldUrl?.trim()
  const newUrl = body.newUrl?.trim().replace(/\/+$/, '')
  if (!oldUrl || !newUrl) return json({ error: 'oldUrl and newUrl required' }, 400)
  if (!URL.canParse(newUrl)) return json({ error: 'invalid url' }, 400)

  const [affected, existingNew] = await Promise.all([getFeedsBySourceUrl(db, oldUrl), getSourceData(db, newUrl)])
  if (oldUrl === newUrl && existingNew?.lastFetched) return json({ ok: true, affected: 0 })
  affected.forEach(f => { f.sources = f.sources.map(s => s === oldUrl ? newUrl : s) })

  let sourceData
  if (existingNew?.lastFetched) {
    sourceData = existingNew
  } else {
    ;({ sourceData } = await fetchAndSaveSource(db, newUrl))
  }

  for (const feed of affected) {
    const sourceDatas = await Promise.all(
      (feed.sources || []).map(u => u === newUrl ? sourceData : getSourceData(db, u))
    )
    if (!sourceDatas.filter(Boolean).length) continue
    applySourceDatas(feed, sourceDatas, { keepOnEmpty: true })
  }

  await Promise.all([
    ...affected.map(f => saveFeed(db, f)),
    oldUrl !== newUrl ? deleteSourceData(db, oldUrl) : Promise.resolve()
  ])
  return json({ ok: true, affected: affected.length })
}

// DELETE /api/discover/admin/source
export const handleSourceDelete = async (req, db) => {
  const body = await parseJsonBody(req)
  if (!body) return json({ error: 'invalid json' }, 400)
  const url = body.url?.trim().replace(/\/+$/, '')
  if (!url) return json({ error: 'url required' }, 400)

  const affected = await getFeedsBySourceUrl(db, url)
  await Promise.all([
    ...affected.map(f => { f.sources = f.sources.filter(s => s !== url); return saveFeed(db, f) }),
    deleteSourceData(db, url),
    deletePostTags(db, url)
  ])
  return json({ ok: true, affected: affected.length })
}

// GET /api/discover/admin/blocked
export const handleBlockedList = async (db) => json(await getBlocked(db))

// PUT /api/discover/admin/blocked
export const handleBlockedSave = async (req, db) => {
  const body = await parseJsonBody(req)
  if (!body || !Array.isArray(body.entries)) return json({ error: 'entries array required' }, 400)
  const entries = [...new Set(body.entries.map(e => String(e).trim()).filter(Boolean))]
  await saveBlocked(db, entries)
  return json({ ok: true, count: entries.length })
}
