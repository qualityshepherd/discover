// D1 replacement for discover-kv.js — same exported interface, same pure helpers

// Stable short hash used as a key suffix for any URL (identical to discover-kv.js)
export const makeId = (url) => {
  const s = String(url).replace(/\/+$/, '')
  let h = 0
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0
  return Math.abs(h).toString(36)
}

// Feeds

const rowToFeed = (row, sources = []) => {
  if (!row) return null
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    type: row.type || undefined,
    tags: JSON.parse(row.tags || '[]'),
    coverImage: row.cover_image || undefined,
    author: row.author ? JSON.parse(row.author) : undefined,
    ownerPubkey: row.owner_pubkey || undefined,
    featured: !!row.featured,
    imports: row.imports || 0,
    active: row.active !== 0,
    updateFrequency: row.update_frequency || undefined,
    lastChecked: row.last_checked || null,
    lastUpdated: row.last_updated || null,
    previewPosts: row.preview_posts ? JSON.parse(row.preview_posts) : undefined,
    failStreak: row.fail_streak || 0,
    curatorPubkey: row.curator_pubkey || undefined,
    curatorName: row.curator_name || undefined,
    curatorUrl: row.curator_url || undefined,
    addedAt: row.added_at,
    sources
  }
}

export const getFeed = async (db, id) => {
  const row = await db.prepare('SELECT * FROM feeds WHERE id = ?').bind(id).first()
  if (!row) return null
  const srcRows = await db.prepare('SELECT source_url FROM feed_sources WHERE feed_id = ? ORDER BY added_at').bind(id).all()
  return rowToFeed(row, srcRows.results.map(r => r.source_url))
}

export const getFeeds = async (db) => {
  const feedRows = await db.prepare('SELECT * FROM feeds').all()
  if (!feedRows.results.length) return []
  const srcRows = await db.prepare('SELECT feed_id, source_url FROM feed_sources ORDER BY added_at').all()
  const byFeed = {}
  for (const { feed_id: fid, source_url: surl } of srcRows.results) {
    if (!byFeed[fid]) byFeed[fid] = []
    byFeed[fid].push(surl)
  }
  return feedRows.results.map(row => rowToFeed(row, byFeed[row.id] || []))
}

export const saveFeed = async (db, feed) => {
  const {
    id, title, description, type, tags, coverImage, author, ownerPubkey, featured, imports,
    active, updateFrequency, lastChecked, lastUpdated, previewPosts, failStreak,
    curatorPubkey, curatorName, curatorUrl, addedAt, sources = []
  } = feed

  await db.prepare(`
    INSERT INTO feeds
      (id, title, description, type, tags, cover_image, author, owner_pubkey, featured, imports,
       active, update_frequency, last_checked, last_updated, preview_posts, fail_streak,
       curator_pubkey, curator_name, curator_url, added_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, description=excluded.description, type=excluded.type,
      tags=excluded.tags, cover_image=excluded.cover_image, author=excluded.author,
      owner_pubkey=excluded.owner_pubkey, featured=excluded.featured, imports=excluded.imports,
      active=excluded.active, update_frequency=excluded.update_frequency,
      last_checked=excluded.last_checked, last_updated=excluded.last_updated,
      preview_posts=excluded.preview_posts, fail_streak=excluded.fail_streak,
      curator_pubkey=excluded.curator_pubkey, curator_name=excluded.curator_name,
      curator_url=excluded.curator_url, updated_at=datetime('now')
  `).bind(
    id, title, description || null, type || null,
    JSON.stringify(tags || []),
    coverImage || null,
    author ? JSON.stringify(author) : null,
    ownerPubkey || null,
    featured ? 1 : 0, imports || 0, active !== false ? 1 : 0,
    updateFrequency || null, lastChecked || null, lastUpdated || null,
    previewPosts ? JSON.stringify(previewPosts) : null,
    failStreak || 0, curatorPubkey || null, curatorName || null, curatorUrl || null,
    addedAt || new Date().toISOString()
  ).run()

  // Replace sources + sync FTS index
  const stmts = [
    db.prepare('DELETE FROM feed_sources WHERE feed_id = ?').bind(id),
    db.prepare('DELETE FROM feeds_fts WHERE feed_id = ?').bind(id),
    db.prepare('INSERT INTO feeds_fts (feed_id, title, description, tags, author) VALUES (?,?,?,?,?)').bind(
      id, title || '', description || '', JSON.stringify(tags || []), author ? JSON.stringify(author) : ''
    )
  ]
  for (const url of sources) {
    stmts.push(db.prepare('INSERT OR IGNORE INTO feed_sources (feed_id, source_url) VALUES (?,?)').bind(id, url))
  }
  await db.batch(stmts)
}

// No separate index table in D1 — feeds table IS the index
export const addToIndex = async (_db, _id) => {}
export const removeFromIndex = async (db, id) => {
  await db.batch([
    db.prepare('DELETE FROM feeds WHERE id = ?').bind(id),
    db.prepare('DELETE FROM feeds_fts WHERE feed_id = ?').bind(id)
  ])
}

// Sources

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

// Curators

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

// No separate curator-index in D1
export const addToCuratorIndex = async (_db, _pubkey) => {}

// User feed

export const getUserFeedSlug = async (db) => {
  const row = await db.prepare("SELECT value FROM settings WHERE key='user-feed:slug'").first()
  return row?.value || null
}

export const setUserFeedSlug = async (db, slug) => {
  await db.prepare(
    "INSERT INTO settings (key,value) VALUES ('user-feed:slug',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(slug).run()
}

export const getUserFeed = async (db, slug) => {
  const row = await db.prepare('SELECT ids, sources, custom_feeds FROM user_feed WHERE slug=?').bind(slug).first()
  if (!row) return null
  return {
    ids: JSON.parse(row.ids || '[]'),
    sources: JSON.parse(row.sources || '[]'),
    customFeeds: JSON.parse(row.custom_feeds || '[]')
  }
}

export const setUserFeed = async (db, slug, data) => {
  await db.prepare(`
    INSERT INTO user_feed (slug, ids, sources, custom_feeds) VALUES (?,?,?,?)
    ON CONFLICT(slug) DO UPDATE SET ids=excluded.ids, sources=excluded.sources, custom_feeds=excluded.custom_feeds
  `).bind(slug, JSON.stringify(data.ids || []), JSON.stringify(data.sources || []), JSON.stringify(data.customFeeds || [])).run()
}

// Pending / Blocked

export const getPending = async (db) => {
  const rows = await db.prepare('SELECT url, title, description, submitted_at FROM pending ORDER BY submitted_at').all()
  return rows.results.map(r => ({ url: r.url, title: r.title || '', description: r.description || '', submittedAt: r.submitted_at }))
}

export const savePending = async (db, list) => {
  const stmts = [db.prepare('DELETE FROM pending')]
  for (const item of list) {
    stmts.push(db.prepare('INSERT INTO pending (url, title, description, submitted_at) VALUES (?,?,?,?)').bind(
      item.url, item.title || '', item.description || '', item.submittedAt || new Date().toISOString()
    ))
  }
  await db.batch(stmts)
}

export const getBlocked = async (db) => {
  const rows = await db.prepare('SELECT domain FROM blocked ORDER BY domain').all()
  return rows.results.map(r => r.domain)
}

export const saveBlocked = async (db, list) => {
  const stmts = [db.prepare('DELETE FROM blocked'), ...list.map(d => db.prepare('INSERT INTO blocked (domain) VALUES (?)').bind(d))]
  await db.batch(stmts)
}

export const isBlocked = async (db, sources) => {
  const blocked = await getBlocked(db)
  if (!blocked.length) return false
  return sources.some(url => {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '')
      return blocked.some(b => host === b || host.endsWith('.' + b))
    } catch { return false }
  })
}

// Mentions

export const getMentions = async (db, domain) => {
  const rows = await db.prepare(
    'SELECT from_source, from_post, from_title, from_date, from_content, to_url, found_at FROM mentions WHERE to_domain=? ORDER BY found_at DESC LIMIT 100'
  ).bind(domain).all()
  return rows.results.map(r => ({
    fromSource: r.from_source,
    fromPost: r.from_post,
    fromTitle: r.from_title || '',
    fromDate: r.from_date || null,
    fromContent: r.from_content || '',
    toUrl: r.to_url || '',
    foundAt: r.found_at
  }))
}

export const getMentionDomainsForSources = async (db, sourceUrls) => {
  if (!sourceUrls.length) return []
  const results = []
  for (let i = 0; i < sourceUrls.length; i += 99) {
    const chunk = sourceUrls.slice(i, i + 99)
    const rows = await db.prepare(
      `SELECT DISTINCT to_domain FROM mentions WHERE from_source IN (${chunk.map(() => '?').join(',')})`
    ).bind(...chunk).all()
    results.push(...rows.results.map(r => r.to_domain))
  }
  return results
}

export const saveMentions = async (db, domain, mentions) => {
  const stmts = [db.prepare('DELETE FROM mentions WHERE to_domain=?').bind(domain)]
  for (const m of mentions) {
    stmts.push(db.prepare(
      'INSERT INTO mentions (from_source, from_post, from_title, from_date, from_content, to_domain, to_url) VALUES (?,?,?,?,?,?,?)'
    ).bind(m.fromSource, m.fromPost, m.fromTitle || null, m.fromDate || null, m.fromContent || null, domain, m.toUrl || null))
  }
  await db.batch(stmts)
}

// Curate candidates / dismissed domains

export const getCandidates = async (db) => {
  const rows = await db.prepare('SELECT * FROM curate_candidates ORDER BY score DESC').all()
  return rows.results.map(r => ({
    domain: r.domain,
    score: r.score,
    sources: JSON.parse(r.sources || '[]'),
    firstSeen: r.first_seen,
    probedAt: r.probed_at,
    feedUrl: r.feed_url
  }))
}

export const saveCandidates = async (db, list) => {
  const stmts = [db.prepare('DELETE FROM curate_candidates')]
  for (const c of list.slice(0, 50)) {
    stmts.push(db.prepare(
      'INSERT INTO curate_candidates (domain, score, sources, first_seen, probed_at, feed_url) VALUES (?,?,?,?,?,?)'
    ).bind(c.domain, c.score, JSON.stringify(c.sources || []), c.firstSeen || null, c.probedAt || null, c.feedUrl || null))
  }
  await db.batch(stmts)
}

export const getDismissedDomains = async (db) => {
  const rows = await db.prepare('SELECT domain FROM dismissed_domains').all()
  return rows.results.map(r => r.domain)
}

export const addDismissedDomain = async (db, domain) => {
  await db.prepare('INSERT OR IGNORE INTO dismissed_domains (domain) VALUES (?)').bind(domain).run()
}

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

// Paginated + filtered feed list using keyset pagination.
// cursor is base64-encoded { f, i, id } from the last row of the previous page.
export const getFilteredFeeds = async (db, { tag, q, limit = 50, cursor } = {}) => {
  const where = ['EXISTS (SELECT 1 FROM feed_sources WHERE feed_id = f.id)']
  const params = []

  if (tag) {
    where.push('EXISTS (SELECT 1 FROM json_each(f.tags) jt WHERE jt.value = ?)')
    params.push(tag)
  }

  if (q) {
    const ftsQ = q.replace(/[^\w\s]/g, ' ').trim().split(/\s+/).filter(Boolean)
      .map((t, i, a) => i === a.length - 1 ? t + '*' : t).join(' ')
    const like = `%${q}%`
    if (ftsQ) {
      where.push('(f.id IN (SELECT feed_id FROM feeds_fts WHERE feeds_fts MATCH ?) OR EXISTS (SELECT 1 FROM feed_sources fs2 WHERE fs2.feed_id = f.id AND LOWER(fs2.source_url) LIKE LOWER(?)))')
      params.push(ftsQ, like)
    } else {
      where.push('(LOWER(f.title) LIKE LOWER(?) OR LOWER(f.description) LIKE LOWER(?) OR LOWER(f.tags) LIKE LOWER(?))')
      params.push(like, like, like)
    }
  }

  let cur = null
  if (cursor) { try { cur = JSON.parse(atob(cursor)) } catch {} }
  if (cur) {
    where.push('((f.featured < ?) OR (f.featured = ? AND f.imports < ?) OR (f.featured = ? AND f.imports = ? AND f.id > ?))')
    params.push(cur.f, cur.f, cur.i, cur.f, cur.i, cur.id)
  }

  const rows = await db.prepare(
    `SELECT f.* FROM feeds f WHERE ${where.join(' AND ')} ORDER BY f.featured DESC, f.imports DESC, f.id ASC LIMIT ?`
  ).bind(...params, limit + 1).all()

  const hasMore = rows.results.length > limit
  const feedRows = rows.results.slice(0, limit)
  if (!feedRows.length) return { feeds: [], cursor: null }

  const ids = feedRows.map(f => f.id)
  const srcRows = []
  for (let i = 0; i < ids.length; i += 99) {
    const chunk = ids.slice(i, i + 99)
    const r = await db.prepare(
      `SELECT feed_id, source_url FROM feed_sources WHERE feed_id IN (${chunk.map(() => '?').join(',')}) ORDER BY added_at`
    ).bind(...chunk).all()
    srcRows.push(...r.results)
  }
  const byFeed = {}
  for (const { feed_id: fid, source_url: surl } of srcRows) {
    if (!byFeed[fid]) byFeed[fid] = []
    byFeed[fid].push(surl)
  }

  const last = feedRows[feedRows.length - 1]
  const nextCursor = hasMore ? btoa(JSON.stringify({ f: last.featured, i: last.imports, id: last.id })) : null
  return { feeds: feedRows.map(row => rowToFeed(row, byFeed[row.id] || [])), cursor: nextCursor }
}

// Source-level search — returns individual blogs with their playlist memberships
export const searchSources = async (db, { q, tag } = {}) => {
  if (!q && !tag) return []
  const where = ['s.has_posts = 1']
  const params = []

  if (q) {
    const like = `%${q}%`
    where.push('(LOWER(COALESCE(s.title, s.url)) LIKE LOWER(?) OR LOWER(s.url) LIKE LOWER(?))')
    params.push(like, like)
  }

  if (tag) {
    where.push('EXISTS (SELECT 1 FROM feed_sources fs2, feeds f2, json_each(f2.tags) jt WHERE fs2.source_url = s.url AND f2.id = fs2.feed_id AND jt.value = ?)')
    params.push(tag)
  }

  const rows = await db.prepare(`
    SELECT s.url, s.title, s.posts,
           json_group_array(json_object('id', f.id, 'title', f.title, 'tags', json(COALESCE(f.tags, '[]')))) AS playlists
    FROM sources s
    JOIN feed_sources fs ON s.url = fs.source_url
    JOIN feeds f ON f.id = fs.feed_id
    WHERE ${where.join(' AND ')}
    GROUP BY s.url
    ORDER BY s.latest_post_date DESC
    LIMIT 50
  `).bind(...params).all()

  const byDomain = new Map()
  for (const r of rows.results) {
    let domain
    try { domain = new URL(r.url).hostname.replace(/^www\./, '') } catch { domain = r.url }
    if (!byDomain.has(domain)) byDomain.set(domain, { r, playlists: [] })
    byDomain.get(domain).playlists.push(...JSON.parse(r.playlists || '[]'))
  }
  return [...byDomain.values()].flatMap(({ r, playlists }) => {
    const posts = JSON.parse(r.posts || '[]')
    const post = posts[0]
    if (!post) return []
    return [{ ...post, fromPlaylist: playlists[0]?.title || r.title || r.url, fromPlaylistId: playlists[0]?.id || null, playlists }]
  })
}

// Tag counts across all feeds — for the tag cloud
export const getTagCounts = async (db) => {
  const rows = await db.prepare(
    'SELECT jt.value AS tag, COUNT(*) AS count FROM feeds f, json_each(f.tags) jt GROUP BY jt.value ORDER BY count DESC, jt.value ASC'
  ).all()
  return rows.results.map(r => ({ tag: r.tag, count: r.count }))
}

// Whether any source was added after cutoffIso
export const hasNewSources = async (db, cutoffIso) => {
  const row = await db.prepare('SELECT 1 FROM sources WHERE added_at > ? LIMIT 1').bind(cutoffIso).first()
  return !!row
}

// { [domain]: count } — live from mentions table, never stale
export const getSourceMentionCounts = async (db) => {
  const rows = await db.prepare('SELECT to_domain, COUNT(*) AS cnt FROM mentions GROUP BY to_domain').all()
  const counts = {}
  for (const row of rows.results) {
    counts[row.to_domain] = row.cnt // eslint-disable-line camelcase
  }
  return counts
}

// Latest post per source, ordered by date — for the /new view
// Only includes sources referenced by at least one feed. Deduped by source URL.
export const getNewestSourcePosts = async (db) => {
  const rows = await db.prepare(`
    SELECT s.url, s.posts, fs.feed_id, f.title AS feed_title, f.id AS playlist_id
    FROM sources s
    JOIN feed_sources fs ON s.url = fs.source_url
    JOIN feeds f ON fs.feed_id = f.id
    WHERE s.has_posts = 1
    ORDER BY s.latest_post_date DESC
  `).all()
  const seen = new Set()
  return rows.results
    .filter(r => { if (seen.has(r.url)) return false; seen.add(r.url); return true })
    .map(r => ({
      url: r.url,
      posts: JSON.parse(r.posts || '[]'),
      playlist: { title: r.feed_title, id: r.playlist_id }
    }))
}

// All sources with posts — caller shuffles the expanded post corpus
export const getRandomSourcePosts = async (db) => {
  const rows = await db.prepare(`
    SELECT s.posts, f.title AS feed_title, f.id AS feed_id
    FROM sources s
    JOIN (SELECT source_url, MIN(feed_id) AS feed_id FROM feed_sources GROUP BY source_url) fs ON s.url = fs.source_url
    JOIN feeds f ON f.id = fs.feed_id
    WHERE s.has_posts = 1
  `).all()
  return rows.results.map(r => ({
    posts: JSON.parse(r.posts || '[]'),
    playlist: { title: r.feed_title, id: r.feed_id }
  }))
}

// Whether a URL exists in any feed's sources
export const isFeedSource = async (db, url) => {
  const row = await db.prepare('SELECT 1 FROM feed_sources WHERE source_url = ? LIMIT 1').bind(url).first()
  return !!row
}

// Whether a URL is in any feed OTHER than excludeFeedId
export const isSourceReferencedElsewhere = async (db, url, excludeFeedId) => {
  const row = await db.prepare(
    'SELECT 1 FROM feed_sources WHERE source_url = ? AND feed_id != ? LIMIT 1'
  ).bind(url, excludeFeedId).first()
  return !!row
}

// All feeds that contain a given source URL — for bulk rename/delete operations
export const getFeedsBySourceUrl = async (db, url) => {
  const feedRows = await db.prepare(`
    SELECT f.* FROM feeds f
    JOIN feed_sources fs ON f.id = fs.feed_id
    WHERE fs.source_url = ?
  `).bind(url).all()
  if (!feedRows.results.length) return []
  const ids = feedRows.results.map(f => f.id)
  const srcRows = []
  for (let i = 0; i < ids.length; i += 99) {
    const chunk = ids.slice(i, i + 99)
    const r = await db.prepare(
      `SELECT feed_id, source_url FROM feed_sources WHERE feed_id IN (${chunk.map(() => '?').join(',')}) ORDER BY added_at`
    ).bind(...chunk).all()
    srcRows.push(...r.results)
  }
  const byFeed = {}
  for (const { feed_id: fid, source_url: surl } of srcRows) {
    if (!byFeed[fid]) byFeed[fid] = []
    byFeed[fid].push(surl)
  }
  return feedRows.results.map(row => rowToFeed(row, byFeed[row.id] || []))
}

// Pure logic helpers (unchanged from discover-kv.js)

export const isCuratorOf = (curator, playlistId) => !!(curator && curator.playlistId === playlistId)

export const shouldUpdateLastSeen = (curator, now = Date.now()) =>
  !curator?.lastSeen || now - new Date(curator.lastSeen).getTime() > 24 * 60 * 60 * 1000

export const isCuratorInactive = (curator, now = Date.now()) =>
  !!(curator?.lastSeen && now - new Date(curator.lastSeen).getTime() > 180 * 24 * 60 * 60 * 1000)

export const computeTags = (feeds) => {
  const counts = {}
  for (const f of feeds) for (const tag of (f.tags || [])) counts[tag] = (counts[tag] || 0) + 1
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => ({ tag, count }))
}
