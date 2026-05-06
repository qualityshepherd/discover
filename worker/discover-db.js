// D1 replacement for discover-kv.js — same exported interface, same pure helpers

// Stable short hash used as a key suffix for any URL (identical to discover-kv.js)
export const makeId = (url) => {
  const s = String(url).replace(/\/+$/, '')
  let h = 0
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0
  return Math.abs(h).toString(36)
}

// Constants kept for compatibility with callers that import them
export const KV_INDEX = 'discover:index'
export const KV_PREFIX = 'discover:feed:'
export const KV_FEEDS_LIST = 'discover:feeds-list'
export const KV_SOURCE_INDEX = 'discover:source-index'
export const KV_SOURCE_PREFIX = 'discover:source:'
export const KV_PENDING = 'discover:pending'
export const KV_BLOCKED = 'discover:blocked'
export const KV_CURATE_CANDIDATES = 'discover:curate-candidates'
export const KV_DISMISSED_DOMAINS = 'discover:dismissed-domains'

// ── Feeds ────────────────────────────────────────────────────────────────────

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

  // Replace sources
  const stmts = [db.prepare('DELETE FROM feed_sources WHERE feed_id = ?').bind(id)]
  for (const url of sources) {
    stmts.push(db.prepare('INSERT OR IGNORE INTO feed_sources (feed_id, source_url) VALUES (?,?)').bind(id, url))
  }
  await db.batch(stmts)
}

export const saveFeeds = async (db, _allFeeds, updated) => {
  for (const feed of updated) await saveFeed(db, feed)
}

// No separate index table in D1 — feeds table IS the index
export const addToIndex = async (_db, _id) => {}
export const removeFromIndex = async (db, id) => {
  await db.prepare('DELETE FROM feeds WHERE id = ?').bind(id).run()
}

// ── Sources ──────────────────────────────────────────────────────────────────

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
      (url, site_url, posts, image, status_code, error, frequency, has_posts, latest_post_url, latest_post_date, last_fetched)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(url) DO UPDATE SET
      site_url=excluded.site_url, posts=excluded.posts, image=excluded.image,
      status_code=excluded.status_code, error=excluded.error,
      frequency=COALESCE(excluded.frequency, sources.frequency),
      has_posts=excluded.has_posts, latest_post_url=excluded.latest_post_url,
      latest_post_date=excluded.latest_post_date, last_fetched=excluded.last_fetched
  `).bind(
    url, data.siteUrl || null, JSON.stringify(posts),
    data.image || null, data.statusCode ?? null, data.error || null,
    data.frequency || null,
    posts.length > 0 ? 1 : 0,
    latestPost?.url || null, latestPost?.date || null,
    data.lastFetched || new Date().toISOString()
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

// Returns the same { [hash]: { url, lastFetched, ... } } shape as the KV source-index
export const getSourceIndex = async (db) => {
  const rows = await db.prepare(
    'SELECT url, status_code, error, has_posts, latest_post_url, latest_post_date, image, frequency, mention_count, last_fetched, added_at FROM sources'
  ).all()
  const index = {}
  for (const row of rows.results) {
    index[makeId(row.url)] = {
      url: row.url,
      lastFetched: row.last_fetched || null,
      statusCode: row.status_code || null,
      error: row.error || null,
      hasPosts: !!row.has_posts,
      latestPostUrl: row.latest_post_url || null,
      latestPostDate: row.latest_post_date || null,
      image: row.image || null,
      frequency: row.frequency || null,
      addedAt: row.added_at,
      mentionCount: row.mention_count || 0
    }
  }
  return index
}

// Batch-upsert a mutated sourceIndex object (used by buildLinkGraph for mentionCount updates)
export const saveSourceIndex = async (db, sourceIndex) => {
  const entries = Object.values(sourceIndex)
  if (!entries.length) return
  const stmts = entries.map(e =>
    db.prepare(`
      INSERT INTO sources (url, status_code, error, has_posts, latest_post_url, latest_post_date, image, frequency, mention_count, last_fetched, added_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(url) DO UPDATE SET
        status_code=excluded.status_code, error=excluded.error,
        has_posts=excluded.has_posts, latest_post_url=excluded.latest_post_url,
        latest_post_date=excluded.latest_post_date, image=excluded.image,
        frequency=COALESCE(excluded.frequency, sources.frequency),
        mention_count=excluded.mention_count, last_fetched=excluded.last_fetched
    `).bind(
      e.url, e.statusCode || null, e.error || null,
      e.hasPosts ? 1 : 0, e.latestPostUrl || null, e.latestPostDate || null,
      e.image || null, e.frequency || null, e.mentionCount || 0,
      e.lastFetched || null, e.addedAt || new Date().toISOString()
    )
  )
  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100))
  }
}

// Targeted mentionCount updates — avoids full saveSourceIndex for buildLinkGraph
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

// ── Curators ─────────────────────────────────────────────────────────────────

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

// ── User feed ─────────────────────────────────────────────────────────────────

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

// ── Pending / Blocked ─────────────────────────────────────────────────────────

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

// ── Mentions ─────────────────────────────────────────────────────────────────

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

export const saveMentions = async (db, domain, mentions) => {
  const stmts = [db.prepare('DELETE FROM mentions WHERE to_domain=?').bind(domain)]
  for (const m of mentions) {
    stmts.push(db.prepare(
      'INSERT INTO mentions (from_source, from_post, from_title, from_date, from_content, to_domain, to_url) VALUES (?,?,?,?,?,?,?)'
    ).bind(m.fromSource, m.fromPost, m.fromTitle || null, m.fromDate || null, m.fromContent || null, domain, m.toUrl || null))
  }
  await db.batch(stmts)
}

// ── Curate candidates / dismissed domains ────────────────────────────────────

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

// ── Settings / cron state ────────────────────────────────────────────────────

export const getCronState = async (db, key) => {
  const row = await db.prepare('SELECT value FROM settings WHERE key=?').bind(key).first()
  return row?.value || null
}

export const setCronState = async (db, key, value) => {
  await db.prepare(
    'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).bind(key, value).run()
}

// ── Sessions / rate limits (used by auth.js) ─────────────────────────────────

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

// ── Pure logic helpers (unchanged from discover-kv.js) ───────────────────────

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
