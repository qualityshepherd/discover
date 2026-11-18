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
  // quiet first - see quietFirst in discover-cron.js
  const rows = await db.prepare('SELECT * FROM curate_candidates ORDER BY score ASC, first_seen DESC').all()
  return rows.results.map(r => ({
    domain: r.domain,
    score: r.score,
    sources: JSON.parse(r.sources || '[]'),
    firstSeen: r.first_seen,
    probedAt: r.probed_at,
    feedUrl: r.feed_url
  }))
}

// Diffs against what's stored instead of wipe-and-rewrite: the daily cron
// calls this, and rewriting 150 rows (plus the PK index) to change two of
// them was ~600 writes for nothing. Same shape as saveMentions.
// Callers cap the list - buildCurateCandidates keeps 50 found + 100 failed.
export const saveCandidates = async (db, list) => {
  const stored = new Map((await getCandidates(db)).map(c => [c.domain, c]))
  const row = c => [c.score, JSON.stringify(c.sources || []), c.firstSeen || null, c.probedAt || null, c.feedUrl || null]
  const wanted = new Map(list.map(c => [c.domain, c]))
  const stmts = []
  for (const domain of stored.keys()) {
    if (!wanted.has(domain)) stmts.push(db.prepare('DELETE FROM curate_candidates WHERE domain=?').bind(domain))
  }
  for (const [domain, c] of wanted) {
    const prev = stored.get(domain)
    if (!prev) {
      stmts.push(db.prepare(
        'INSERT INTO curate_candidates (domain, score, sources, first_seen, probed_at, feed_url) VALUES (?,?,?,?,?,?)'
      ).bind(domain, ...row(c)))
    } else if (JSON.stringify(row(prev)) !== JSON.stringify(row(c))) {
      stmts.push(db.prepare(
        'UPDATE curate_candidates SET score=?, sources=?, first_seen=?, probed_at=?, feed_url=? WHERE domain=?'
      ).bind(...row(c), domain))
    }
  }
  if (stmts.length) await db.batch(stmts)
}

export const getDismissedDomains = async (db) => {
  const rows = await db.prepare('SELECT domain FROM dismissed_domains').all()
  return rows.results.map(r => r.domain)
}

export const addDismissedDomain = async (db, domain) => {
  await db.prepare('INSERT OR IGNORE INTO dismissed_domains (domain) VALUES (?)').bind(domain).run()
}
