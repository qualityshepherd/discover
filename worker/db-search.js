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
           json_group_array(json_object('id', f.id, 'slug', f.slug, 'title', f.title, 'tags', json(COALESCE(f.tags, '[]')))) AS playlists
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

// Post tags

// Writes only the difference between the stored tags for a source and the fresh
// fetch. D1 bills every row touched (including index entries), and most fetches
// change nothing, so delete-everything-and-reinsert burned the daily write budget.
export const savePostTags = async (db, sourceUrl, posts) => {
  const wanted = new Map()
  for (const post of posts) {
    if (!post.url || !post.tags?.length) continue
    for (const tag of post.tags) wanted.set(`${post.url}\n${tag}`, { postUrl: post.url, tag, date: post.date || null })
  }

  const stored = await db.prepare('SELECT post_url, tag, post_date FROM post_tags WHERE source_url = ?').bind(sourceUrl).all()
  const stmts = []
  const present = new Set()
  for (const row of stored.results) {
    const key = `${row.post_url}\n${row.tag}`
    const want = wanted.get(key)
    if (!want) {
      stmts.push(db.prepare('DELETE FROM post_tags WHERE post_url = ? AND tag = ?').bind(row.post_url, row.tag))
    } else {
      present.add(key)
      if ((row.post_date || null) !== want.date) {
        stmts.push(db.prepare('UPDATE post_tags SET post_date = ? WHERE post_url = ? AND tag = ?').bind(want.date, row.post_url, row.tag))
      }
    }
  }
  for (const [key, want] of wanted) {
    if (present.has(key)) continue
    stmts.push(db.prepare(
      'INSERT OR IGNORE INTO post_tags (source_url, post_url, tag, post_date) VALUES (?,?,?,?)'
    ).bind(sourceUrl, want.postUrl, want.tag, want.date))
  }
  if (stmts.length) await db.batch(stmts)
}

export const deletePostTags = async (db, sourceUrl) => {
  await db.prepare('DELETE FROM post_tags WHERE source_url = ?').bind(sourceUrl).run()
}

// Tags with 2+ distinct sources — for the tag cloud
export const getTagCloud = async (db) => {
  const rows = await db.prepare(`
    SELECT tag, COUNT(DISTINCT pt.source_url) AS source_count, COUNT(*) AS post_count
    FROM post_tags pt
    JOIN feed_sources fs ON fs.source_url = pt.source_url
    GROUP BY tag
    HAVING COUNT(DISTINCT pt.source_url) >= 2
    ORDER BY post_count DESC, source_count DESC
    LIMIT 200
  `).all()
  return rows.results.map(r => ({ tag: r.tag, count: r.source_count }))
}

// Posts for a given tag, reverse-chron, with playlist info
export const getPostsByTag = async (db, tag) => {
  const rows = await db.prepare(`
    SELECT pt.source_url, pt.post_url, pt.post_date,
           s.posts, f.title AS feed_title, f.id AS playlist_id, f.slug AS playlist_slug
    FROM post_tags pt
    JOIN sources s ON s.url = pt.source_url
    JOIN feed_sources fs ON fs.source_url = pt.source_url
    JOIN feeds f ON f.id = fs.feed_id
    WHERE pt.tag = ?
    ORDER BY pt.post_date DESC
    LIMIT 200
  `).bind(tag).all()

  const seen = new Set()
  return rows.results.flatMap(r => {
    const posts = JSON.parse(r.posts || '[]')
    const post = posts.find(p => p.url === r.post_url)
    if (!post || seen.has(r.post_url)) return []
    seen.add(r.post_url)
    return [{ ...post, fromPlaylist: r.feed_title, fromPlaylistId: r.playlist_id, fromPlaylistSlug: r.playlist_slug }]
  })
}
