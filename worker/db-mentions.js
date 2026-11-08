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

// Diffs against the stored rows for this domain instead of delete-and-reinsert.
// (from_post, to_domain) is UNIQUE, so from_post identifies a mention. Unchanged
// rows are not touched, which also keeps their original found_at.
export const saveMentions = async (db, domain, mentions) => {
  const stored = await db.prepare(
    'SELECT from_source, from_post, from_title, from_date, from_content, to_url FROM mentions WHERE to_domain=?'
  ).bind(domain).all()

  const wanted = new Map(mentions.map(m => [m.fromPost, m]))
  const stmts = []
  const present = new Set()
  for (const row of stored.results) {
    const m = wanted.get(row.from_post)
    if (!m) {
      stmts.push(db.prepare('DELETE FROM mentions WHERE to_domain=? AND from_post=?').bind(domain, row.from_post))
      continue
    }
    present.add(row.from_post)
    const changed =
      (row.from_source || '') !== (m.fromSource || '') ||
      (row.from_title || '') !== (m.fromTitle || '') ||
      (row.from_date || null) !== (m.fromDate || null) ||
      (row.from_content || '') !== (m.fromContent || '') ||
      (row.to_url || '') !== (m.toUrl || '')
    if (changed) {
      stmts.push(db.prepare(
        'UPDATE mentions SET from_source=?, from_title=?, from_date=?, from_content=?, to_url=? WHERE to_domain=? AND from_post=?'
      ).bind(m.fromSource, m.fromTitle || null, m.fromDate || null, m.fromContent || null, m.toUrl || null, domain, m.fromPost))
    }
  }
  for (const [fromPost, m] of wanted) {
    if (present.has(fromPost)) continue
    stmts.push(db.prepare(
      'INSERT INTO mentions (from_source, from_post, from_title, from_date, from_content, to_domain, to_url) VALUES (?,?,?,?,?,?,?)'
    ).bind(m.fromSource, m.fromPost, m.fromTitle || null, m.fromDate || null, m.fromContent || null, domain, m.toUrl || null))
  }
  if (stmts.length) await db.batch(stmts)
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
