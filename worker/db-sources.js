export const makeId = (url) => {
  const s = String(url).replace(/\/+$/, '')
  let h = 0
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0
  return Math.abs(h).toString(36)
}

const rowToSourceData = (row) => {
  if (!row) return null
  return {
    url: row.url,
    siteUrl: row.site_url || null,
    posts: JSON.parse(row.posts || '[]'),
    image: row.image || null,
    statusCode: row.status_code || null,
    error: row.error || null,
    lastFetched: row.last_fetched || null
  }
}

export const getSourceData = async (db, url) => {
  const row = await db.prepare('SELECT * FROM sources WHERE url = ?').bind(url).first()
  return rowToSourceData(row)
}

export const getSourceDataBulk = async (db, urls) => {
  if (!urls.length) return new Map()
  const map = new Map()
  for (let i = 0; i < urls.length; i += 99) {
    const chunk = urls.slice(i, i + 99)
    const { results } = await db.prepare(
      `SELECT * FROM sources WHERE url IN (${chunk.map(() => '?').join(',')})`
    ).bind(...chunk).all()
    for (const row of results) map.set(row.url, rowToSourceData(row))
  }
  return map
}

export const saveSourceData = async (db, url, data) => {
  const posts = data.posts || []
  const latestPost = posts[0]
  await db.prepare(`
    INSERT INTO sources
      (url, site_url, posts, image, status_code, error, frequency, has_posts, latest_post_url, latest_post_date, last_fetched, title)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(url) DO UPDATE SET
      site_url=excluded.site_url, posts=excluded.posts, image=excluded.image,
      status_code=excluded.status_code, error=excluded.error,
      frequency=COALESCE(excluded.frequency, sources.frequency),
      has_posts=excluded.has_posts, latest_post_url=excluded.latest_post_url,
      latest_post_date=excluded.latest_post_date, last_fetched=excluded.last_fetched,
      title=COALESCE(excluded.title, sources.title)
  `).bind(
    url, data.siteUrl || null, JSON.stringify(posts),
    data.image || null, data.statusCode ?? null, data.error || null,
    data.frequency || null,
    posts.length > 0 ? 1 : 0,
    latestPost?.url || null, latestPost?.date || null,
    data.lastFetched || new Date().toISOString(),
    data.title || latestPost?.feed?.title || null
  ).run()
}

// Update only index-style metadata (lastFetched, statusCode, error) without overwriting posts
export const updateSourceMeta = async (db, url, meta) => {
  await db.prepare(`
    INSERT INTO sources (url, status_code, error, frequency, last_fetched)
    VALUES (?,?,?,?,?)
    ON CONFLICT(url) DO UPDATE SET
      status_code=excluded.status_code, error=excluded.error,
      frequency=COALESCE(excluded.frequency, sources.frequency),
      last_fetched=excluded.last_fetched
  `).bind(
    url, meta.statusCode ?? null, meta.error || null,
    meta.frequency || null, meta.lastFetched || new Date().toISOString()
  ).run()
}

export const deleteSourceData = async (db, url) => {
  await db.prepare('DELETE FROM sources WHERE url = ?').bind(url).run()
}

// Targeted mentionCount updates — used by buildLinkGraph
export const updateMentionCounts = async (db, changes) => {
  if (!changes.length) return
  const stmts = changes.map(({ url, count }) =>
    db.prepare('UPDATE sources SET mention_count=? WHERE url=?').bind(count, url)
  )
  await db.batch(stmts)
}

// Returns { [hash]: { url, posts, image, siteUrl } } for the requested URLs (replaces source:all blob)
export const getSourceAllData = async (db, urls) => {
  if (!urls.length) return {}
  const result = {}
  for (let i = 0; i < urls.length; i += 99) {
    const chunk = urls.slice(i, i + 99)
    const rows = await db.prepare(
      `SELECT url, posts, image, site_url FROM sources WHERE url IN (${chunk.map(() => '?').join(',')})`
    ).bind(...chunk).all()
    for (const row of rows.results) {
      result[makeId(row.url)] = {
        url: row.url,
        posts: JSON.parse(row.posts || '[]'),
        image: row.image || null,
        siteUrl: row.site_url || null
      }
    }
  }
  return result
}

// All source URLs (lightweight — no JSON blobs)
export const getAllSourceUrls = async (db) => {
  const rows = await db.prepare('SELECT url FROM sources').all()
  return rows.results.map(r => r.url)
}

// Fetch+frequency metadata for all sources in any feed — for cron stale check
export const getStaleSourceMeta = async (db, { limit } = {}) => {
  const sql = `
    SELECT fs.source_url AS url, s.last_fetched, s.frequency, s.latest_post_url, s.latest_post_date,
           s.image, s.added_at, s.status_code, s.error, s.has_posts, s.mention_count
    FROM (SELECT DISTINCT source_url FROM feed_sources) fs
    LEFT JOIN sources s ON s.url = fs.source_url
    ORDER BY s.last_fetched ASC${limit ? ' LIMIT ?' : ''}
  `
  const rows = await (limit ? db.prepare(sql).bind(limit) : db.prepare(sql)).all()
  return rows.results.map(r => ({
    url: r.url,
    lastFetched: r.last_fetched || null,
    frequency: r.frequency || null,
    latestPostUrl: r.latest_post_url || null,
    latestPostDate: r.latest_post_date || null,
    image: r.image || null,
    addedAt: r.added_at || null,
    statusCode: r.status_code || null,
    error: r.error || null,
    hasPosts: !!r.has_posts,
    mentionCount: r.mention_count || 0
  }))
}

// Whether any source was added after cutoffIso
export const hasNewSources = async (db, cutoffIso) => {
  const row = await db.prepare('SELECT 1 FROM sources WHERE added_at > ? LIMIT 1').bind(cutoffIso).first()
  return !!row
}
