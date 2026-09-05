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

// { [domain]: count } — live from mentions table, never stale
export const getSourceMentionCounts = async (db) => {
  const rows = await db.prepare('SELECT to_domain, COUNT(*) AS cnt FROM mentions GROUP BY to_domain').all()
  const counts = {}
  for (const row of rows.results) {
    counts[row.to_domain] = row.cnt // eslint-disable-line camelcase
  }
  return counts
}
