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

// Post tags

export const savePostTags = async (db, sourceUrl, posts) => {
  const stmts = [db.prepare('DELETE FROM post_tags WHERE source_url = ?').bind(sourceUrl)]
  for (const post of posts) {
    if (!post.url || !post.tags?.length) continue
    for (const tag of post.tags) {
      stmts.push(db.prepare(
        'INSERT OR IGNORE INTO post_tags (source_url, post_url, tag, post_date) VALUES (?,?,?,?)'
      ).bind(sourceUrl, post.url, tag, post.date || null))
    }
  }
  await db.batch(stmts)
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
           s.posts, f.title AS feed_title, f.id AS playlist_id
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
    return [{ ...post, fromPlaylist: r.feed_title, fromPlaylistId: r.playlist_id }]
  })
}
