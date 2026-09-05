import { json, parseJsonBody } from './utils.js'
import { getFeed, saveFeed } from './db-feeds.js'
import { getCurator, saveCurator, deleteCurator, listCurators } from './db-curators.js'

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
  await Promise.all([saveCurator(db, pubkey, curator), saveFeed(db, feed)])
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
