import { json, parseJsonBody, cleanFeedUrl } from './utils.js'
import { getSourceData, deleteSourceData } from './db-sources.js'
import { getFeed, saveFeed, isSourceReferencedElsewhere } from './db-feeds.js'
import { deletePostTags } from './db-search.js'
import { fetchAndSaveSource, applySourceDatas } from './fetch-source.js'

// POST /api/discover/admin/:id/sources
export const handlePlaylistSourceAdd = async (req, db, id, domain) => {
  const body = await parseJsonBody(req)
  if (!body) return json({ error: 'invalid json' }, 400)
  const url = cleanFeedUrl(body.url)
  if (!url) return json({ error: 'url required' }, 400)
  const feed = await getFeed(db, id)
  if (!feed) return json({ error: 'not found' }, 404)
  if ((feed.sources || []).includes(url)) return json({ ok: true, existing: true })
  await addSourceToPlaylist(db, feed, url, domain)
  return json({ ok: true })
}

// every way into a playlist goes through here: the feed gets fetched now,
// not whenever the cron gets to it, so the playlist shows it right away
export const addSourceToPlaylist = async (db, feed, rawUrl, domain) => {
  const url = cleanFeedUrl(rawUrl)
  feed.sources = [...new Set([...(feed.sources || []), url])]
  const sourceData = await getSourceData(db, url) || (await fetchAndSaveSource(db, url, domain)).sourceData
  if (sourceData?.posts?.length) {
    feed.previewPosts = [...(feed.previewPosts || []), sourceData.posts[0]].sort((a, b) => new Date(b.date) - new Date(a.date))
    if (!feed.coverImage && sourceData.image) feed.coverImage = sourceData.image
  }
  await saveFeed(db, feed)
}

// POST /api/discover/admin/:id/refresh
export const handlePlaylistRefresh = async (db, id, domain) => {
  const feed = await getFeed(db, id)
  if (!feed) return json({ error: 'not found' }, 404)
  if (!feed.sources?.length) return json({ ok: true, fetched: 0 })

  let fetched = 0

  const sourceDatas = await Promise.all(feed.sources.map(async url => {
    const existing = await getSourceData(db, url)
    if (!existing?.lastFetched) {
      const { sourceData } = await fetchAndSaveSource(db, url, domain)
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
  const url = cleanFeedUrl(body.url)
  if (!url) return json({ error: 'url required' }, 400)
  const [feed, stillReferenced] = await Promise.all([getFeed(db, id), isSourceReferencedElsewhere(db, url, id)])
  if (!feed) return json({ error: 'not found' }, 404)
  feed.sources = (feed.sources || []).filter(s => s !== url)

  const sourceDatas = await Promise.all(feed.sources.map(u => getSourceData(db, u)))
  applySourceDatas(feed, sourceDatas)

  await Promise.all([
    saveFeed(db, feed),
    stillReferenced ? Promise.resolve() : deleteSourceData(db, url),
    stillReferenced ? Promise.resolve() : deletePostTags(db, url)
  ])
  return json({ ok: true })
}
