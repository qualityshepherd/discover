// Settings / cron state

export const getCronState = async (db, key) => {
  const row = await db.prepare('SELECT value FROM settings WHERE key=?').bind(key).first()
  return row?.value || null
}

export const setCronState = async (db, key, value) => {
  await db.prepare(
    'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).bind(key, value).run()
}

// Sessions / rate limits (used by auth.js)

export const getSession = async (db, token) => {
  const row = await db.prepare('SELECT pubkey, expires_at FROM sessions WHERE token=?').bind(token).first()
  if (!row) return null
  if (Date.now() > row.expires_at) {
    await db.prepare('DELETE FROM sessions WHERE token=?').bind(token).run()
    return null
  }
  return row.pubkey
}

export const createSession = async (db, token, pubkey, expiresAtMs) => {
  await db.prepare(
    'INSERT INTO sessions (token, pubkey, expires_at) VALUES (?,?,?) ON CONFLICT(token) DO UPDATE SET pubkey=excluded.pubkey, expires_at=excluded.expires_at'
  ).bind(token, pubkey, expiresAtMs).run()
}

export const getRateLimit = async (db, key) => {
  const row = await db.prepare('SELECT count, reset_at FROM rate_limits WHERE key=?').bind(key).first()
  return row ? { count: row.count, resetAt: row.reset_at } : null
}

export const setRateLimit = async (db, key, record) => {
  await db.prepare(
    'INSERT INTO rate_limits (key, count, reset_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count, reset_at=excluded.reset_at'
  ).bind(key, record.count, record.resetAt).run()
}

export const deleteRateLimit = async (db, key) => {
  await db.prepare('DELETE FROM rate_limits WHERE key=?').bind(key).run()
}
