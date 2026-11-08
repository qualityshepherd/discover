export const slugify = (title) =>
  (title || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'playlist'

const rowToFeed = (row, sources = []) => {
  if (!row) return null
  return {
    id: row.id,
    slug: row.slug || null,
    title: row.title,
    description: row.description || '',
    type: row.type || undefined,
    tags: JSON.parse(row.tags || '[]'),
    coverImage: row.cover_image || undefined,
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

// id can be the real hex id or a slug - old links gotta keep working forever
export const getFeed = async (db, id) => {
  const row = await db.prepare('SELECT * FROM feeds WHERE id = ? OR slug = ?').bind(id, id).first()
  if (!row) return null
  const srcRows = await db.prepare('SELECT source_url FROM feed_sources WHERE feed_id = ? ORDER BY added_at').bind(row.id).all()
  return rowToFeed(row, srcRows.results.map(r => r.source_url))
}

// unique slug from a title, -2/-3/... on collision. excludeId so editing a
// playlist doesn't collide with its own slug
export const generateUniqueSlug = async (db, title, excludeId = null) => {
  const base = slugify(title)
  let slug = base
  let n = 2
  while (true) {
    const row = excludeId
      ? await db.prepare('SELECT 1 FROM feeds WHERE slug = ? AND id != ?').bind(slug, excludeId).first()
      : await db.prepare('SELECT 1 FROM feeds WHERE slug = ?').bind(slug).first()
    if (!row) return slug
    slug = `${base}-${n++}`
  }
}

// backfill for playlists that predate slugs - only fills NULLs, safe to rerun
export const backfillSlugs = async (db) => {
  const { results } = await db.prepare('SELECT id, title FROM feeds WHERE slug IS NULL').all()
  let count = 0
  for (const { id, title } of results) {
    const slug = await generateUniqueSlug(db, title, id)
    await db.prepare('UPDATE feeds SET slug = ? WHERE id = ?').bind(slug, id).run()
    count++
  }
  return count
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

// syncChildren: false updates only the feeds row. Use it when title, description, tags
// and sources are unchanged (the cron), since rewriting feed_sources and the FTS index
// costs several billed rows per source on every run.
export const saveFeed = async (db, feed, { syncChildren = true } = {}) => {
  const {
    id, slug, title, description, type, tags, coverImage, ownerPubkey, featured, imports,
    active, updateFrequency, lastChecked, lastUpdated, previewPosts, failStreak,
    curatorPubkey, curatorName, curatorUrl, addedAt, sources = []
  } = feed

  await db.prepare(`
    INSERT INTO feeds
      (id, slug, title, description, type, tags, cover_image, owner_pubkey, featured, imports,
       active, update_frequency, last_checked, last_updated, preview_posts, fail_streak,
       curator_pubkey, curator_name, curator_url, added_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      slug=excluded.slug,
      title=excluded.title, description=excluded.description, type=excluded.type,
      tags=excluded.tags, cover_image=excluded.cover_image,
      owner_pubkey=excluded.owner_pubkey, featured=excluded.featured, imports=excluded.imports,
      active=excluded.active, update_frequency=excluded.update_frequency,
      last_checked=excluded.last_checked, last_updated=excluded.last_updated,
      preview_posts=excluded.preview_posts, fail_streak=excluded.fail_streak,
      curator_pubkey=excluded.curator_pubkey, curator_name=excluded.curator_name,
      curator_url=excluded.curator_url, updated_at=datetime('now')
  `).bind(
    id, slug || null, title, description || null, type || null,
    JSON.stringify(tags || []),
    coverImage || null,
    ownerPubkey || null,
    featured ? 1 : 0, imports || 0, active !== false ? 1 : 0,
    updateFrequency || null, lastChecked || null, lastUpdated || null,
    previewPosts ? JSON.stringify(previewPosts) : null,
    failStreak || 0, curatorPubkey || null, curatorName || null, curatorUrl || null,
    addedAt || new Date().toISOString()
  ).run()

  if (!syncChildren) return

  // Replace sources + sync FTS index
  const stmts = [
    db.prepare('DELETE FROM feed_sources WHERE feed_id = ?').bind(id),
    db.prepare('DELETE FROM feeds_fts WHERE feed_id = ?').bind(id),
    db.prepare('INSERT INTO feeds_fts (feed_id, title, description, tags, author) VALUES (?,?,?,?,?)').bind(
      id, title || '', description || '', JSON.stringify(tags || []), ''
    )
  ]
  for (const url of sources) {
    stmts.push(db.prepare('INSERT OR IGNORE INTO feed_sources (feed_id, source_url) VALUES (?,?)').bind(id, url))
  }
  await db.batch(stmts)
}

// No separate index table in D1 — feeds table IS the index
export const removeFromIndex = async (db, id) => {
  await db.batch([
    db.prepare('DELETE FROM feeds WHERE id = ?').bind(id),
    db.prepare('DELETE FROM feeds_fts WHERE feed_id = ?').bind(id)
  ])
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

// Tag counts across all feeds — for the tag cloud
export const getTagCounts = async (db) => {
  const rows = await db.prepare(
    'SELECT jt.value AS tag, COUNT(*) AS count FROM feeds f, json_each(f.tags) jt GROUP BY jt.value ORDER BY count DESC, jt.value ASC'
  ).all()
  return rows.results.map(r => ({ tag: r.tag, count: r.count }))
}

// Latest post per source, ordered by date — for the /new view
// Only includes sources referenced by at least one feed. Deduped by source URL.
export const getNewestSourcePosts = async (db) => {
  const rows = await db.prepare(`
    SELECT s.url, s.posts, fs.feed_id, f.title AS feed_title, f.id AS playlist_id, f.slug AS playlist_slug
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
      playlist: { title: r.feed_title, id: r.playlist_id, slug: r.playlist_slug || null }
    }))
}

// All sources with posts — caller shuffles the expanded post corpus
export const getRandomSourcePosts = async (db) => {
  const rows = await db.prepare(`
    SELECT s.posts, f.title AS feed_title, f.id AS feed_id, f.slug AS feed_slug
    FROM sources s
    JOIN (SELECT source_url, MIN(feed_id) AS feed_id FROM feed_sources GROUP BY source_url) fs ON s.url = fs.source_url
    JOIN feeds f ON f.id = fs.feed_id
    WHERE s.has_posts = 1
  `).all()
  return rows.results.map(r => ({
    posts: JSON.parse(r.posts || '[]'),
    playlist: { title: r.feed_title, id: r.feed_id, slug: r.feed_slug || null }
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

export const computeTags = (feeds) => {
  const counts = {}
  for (const f of feeds) for (const tag of (f.tags || [])) counts[tag] = (counts[tag] || 0) + 1
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => ({ tag, count }))
}
