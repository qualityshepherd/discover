const rowToCurator = (row) => row
  ? {
      pubkey: row.pubkey,
      playlistId: row.playlist_id || undefined,
      name: row.name || '',
      siteUrl: row.site_url || '',
      createdAt: row.created_at,
      lastSeen: row.last_seen || undefined
    }
  : null

export const getCurator = async (db, pubkey) =>
  rowToCurator(await db.prepare('SELECT * FROM curators WHERE pubkey=?').bind(pubkey).first())

export const saveCurator = async (db, pubkey, data) => {
  await db.prepare(`
    INSERT INTO curators (pubkey, playlist_id, name, site_url, created_at, last_seen)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(pubkey) DO UPDATE SET
      playlist_id=excluded.playlist_id, name=excluded.name,
      site_url=excluded.site_url, last_seen=excluded.last_seen
  `).bind(
    pubkey, data.playlistId || null, data.name || '', data.siteUrl || '',
    data.createdAt || new Date().toISOString(), data.lastSeen || null
  ).run()
}

export const deleteCurator = async (db, pubkey) =>
  db.prepare('DELETE FROM curators WHERE pubkey=?').bind(pubkey).run()

export const listCurators = async (db) => {
  const rows = await db.prepare('SELECT * FROM curators').all()
  return rows.results.map(rowToCurator)
}

export const isCuratorOf = (curator, playlistId) => !!(curator && curator.playlistId === playlistId)

export const shouldUpdateLastSeen = (curator, now = Date.now()) =>
  !curator?.lastSeen || now - new Date(curator.lastSeen).getTime() > 24 * 60 * 60 * 1000

export const isCuratorInactive = (curator, now = Date.now()) =>
  !!(curator?.lastSeen && now - new Date(curator.lastSeen).getTime() > 180 * 24 * 60 * 60 * 1000)
