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

// Exact match or subdomain only - a bare substring check would let
// "example.com" match "notexample.com.evil.org".
export const isUrlBlocked = (url, blockedList) => {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    return blockedList.some(b => host === b || host.endsWith('.' + b))
  } catch { return false }
}

export const isBlocked = async (db, sources) => {
  const blocked = await getBlocked(db)
  if (!blocked.length) return false
  return sources.some(url => isUrlBlocked(url, blocked))
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
