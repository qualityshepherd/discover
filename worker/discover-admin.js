import { json, parseJsonBody, isClickThrough } from './utils.js'
import {
  makeId,
  getFeed, saveFeed, getFeeds,
  addToIndex, removeFromIndex,
  getSourceData, deleteSourceData,
  isBlocked, isSourceReferencedElsewhere, getFeedsBySourceUrl,
  getAllSourceUrls,
  getPending, savePending,
  getBlocked, saveBlocked,
  getCurator, saveCurator, deleteCurator, listCurators, addToCuratorIndex,
  getCandidates, saveCandidates, addDismissedDomain
} from './discover-db.js'
import { fetchAndSaveSource, applySourceDatas, fetchSource, VIDEO_DOMAINS } from './discover-cron.js'

// GET /api/discover/admin/curator
export const handleCuratorList = async (db) => json(await listCurators(db))

// POST /api/discover/admin/curator/invite
export const handleCuratorInvite = async (req, db) => {
  const body = await parseJsonBody(req)
  if (!body) return json({ error: 'invalid json' }, 400)
  const { pubkey, name, siteUrl, playlistId } = body
  if (!pubkey || !playlistId) return json({ error: 'pubkey and playlistId required' }, 400)
  const feed = await getFeed(db, playlistId)
  if (!feed) return json({ error: 'playlist not found' }, 404)
  if (await getCurator(db, pubkey)) return json({ error: 'already a curator' }, 409)
  const now = new Date().toISOString()
  const curator = { playlistId, name: name?.trim() || '', siteUrl: siteUrl?.trim() || '', createdAt: now, lastSeen: now }
  feed.curatorPubkey = pubkey
  feed.curatorName = curator.name
  feed.curatorUrl = curator.siteUrl
  await Promise.all([saveCurator(db, pubkey, curator), addToCuratorIndex(db, pubkey), saveFeed(db, feed)])
  return json({ ok: true })
}

// DELETE /api/discover/admin/curator/:pubkey
export const handleCuratorRevoke = async (db, pubkey) => {
  const curator = await getCurator(db, pubkey)
  if (!curator) return json({ error: 'not found' }, 404)
  const feed = curator.playlistId ? await getFeed(db, curator.playlistId) : null
  if (feed && feed.curatorPubkey === pubkey) {
    delete feed.curatorPubkey
    delete feed.curatorName
    delete feed.curatorUrl
  }
  await Promise.all([deleteCurator(db, pubkey), ...(feed ? [saveFeed(db, feed)] : [])])
  return json({ ok: true })
}

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
    author: { name: body.author?.name?.trim() || '', url: body.author?.url?.trim() || '', pubkey: '' },
    sources,
    imports: 0,
    featured: body.featured || false,
    active: true,
    updateFrequency: 'unknown',
    lastChecked: null,
    addedAt: new Date().toISOString()
  }
  await Promise.all([saveFeed(db, entry), addToIndex(db, id)])
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
  if (body.author !== undefined) {
    feed.author = {
      name: body.author.name?.trim() || '',
      url: body.author.url?.trim() || '',
      pubkey: feed.author?.pubkey || ''
    }
  }

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

// POST /api/discover/admin/:id/sources
export const handlePlaylistSourceAdd = async (req, db, id) => {
  const body = await parseJsonBody(req)
  if (!body) return json({ error: 'invalid json' }, 400)
  const url = body.url?.trim().replace(/\/+$/, '')
  if (!url) return json({ error: 'url required' }, 400)
  const feed = await getFeed(db, id)
  if (!feed) return json({ error: 'not found' }, 404)
  if ((feed.sources || []).includes(url)) return json({ ok: true, existing: true })
  feed.sources = [...(feed.sources || []), url]

  let sourceData = await getSourceData(db, url)
  if (!sourceData) {
    const result = await fetchAndSaveSource(db, url)
    sourceData = result.sourceData
  }

  if (sourceData?.posts?.length) {
    feed.previewPosts = [...(feed.previewPosts || []), sourceData.posts[0]].sort((a, b) => new Date(b.date) - new Date(a.date))
    if (!feed.coverImage && sourceData.image) feed.coverImage = sourceData.image
  }

  await saveFeed(db, feed)
  return json({ ok: true })
}

// POST /api/discover/admin/:id/refresh
export const handlePlaylistRefresh = async (db, id) => {
  const feed = await getFeed(db, id)
  if (!feed) return json({ error: 'not found' }, 404)
  if (!feed.sources?.length) return json({ ok: true, fetched: 0 })

  let fetched = 0

  const sourceDatas = await Promise.all(feed.sources.map(async url => {
    const existing = await getSourceData(db, url)
    if (!existing?.lastFetched) {
      const { sourceData } = await fetchAndSaveSource(db, url)
      fetched++
      return sourceData
    }
    return existing
  }))

  applySourceDatas(feed, sourceDatas)
  feed.lastUpdated = new Date().toISOString()

  await saveFeed(db, feed)
  return json({ ok: true, fetched })
}

// DELETE /api/discover/admin/:id/sources
export const handlePlaylistSourceRemove = async (req, db, id) => {
  const body = await parseJsonBody(req)
  if (!body) return json({ error: 'invalid json' }, 400)
  const url = body.url?.trim().replace(/\/+$/, '')
  if (!url) return json({ error: 'url required' }, 400)
  const [feed, stillReferenced] = await Promise.all([getFeed(db, id), isSourceReferencedElsewhere(db, url, id)])
  if (!feed) return json({ error: 'not found' }, 404)
  feed.sources = (feed.sources || []).filter(s => s !== url)

  const sourceDatas = await Promise.all(feed.sources.map(u => getSourceData(db, u)))
  applySourceDatas(feed, sourceDatas)

  await Promise.all([
    saveFeed(db, feed),
    stillReferenced ? Promise.resolve() : deleteSourceData(db, url)
  ])
  return json({ ok: true })
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
    deleteSourceData(db, url)
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

// GET /api/discover/admin/webping
export const handleWebping = async (db) => {
  const allSourceUrls = await getAllSourceUrls(db)

  const sourceDomains = new Map()
  for (const url of allSourceUrls) {
    try { sourceDomains.set(new URL(url).hostname, url) } catch {}
  }

  const sourceDatas = await Promise.all(allSourceUrls.map(u => getSourceData(db, u)))

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

// GET /api/discover/admin/curate
export const handleCurateGet = async (db) => {
  const [pending, candidates] = await Promise.all([getPending(db), getCandidates(db)])
  return json({ pending, candidates })
}

// POST /api/discover/admin/curate/approve
export const handleCurateApprove = async (req, db) => {
  const body = await parseJsonBody(req)
  if (!body?.domain || !body?.feedUrl) return json({ error: 'domain and feedUrl required' }, 400)
  const [pending, candidates] = await Promise.all([getPending(db), getCandidates(db)])
  if (!pending.find(p => p.url === body.feedUrl)) {
    pending.push({ url: body.feedUrl, title: body.domain, description: '', submittedAt: new Date().toISOString() })
  }
  await Promise.all([
    savePending(db, pending),
    saveCandidates(db, candidates.filter(c => c.domain !== body.domain))
  ])
  return json({ ok: true })
}

// DELETE /api/discover/admin/curate/candidate
export const handleCurateDismissCandidate = async (req, db) => {
  const body = await parseJsonBody(req)
  if (!body?.domain) return json({ error: 'domain required' }, 400)
  const candidates = await getCandidates(db)
  await Promise.all([
    saveCandidates(db, candidates.filter(c => c.domain !== body.domain)),
    addDismissedDomain(db, body.domain)
  ])
  return json({ ok: true })
}
