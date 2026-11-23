import { urlMatchKey } from './url-normalize.js'
import { bareHost } from './utils.js'

const toMention = r => ({
  fromSource: r.from_source,
  fromPost: r.from_post,
  fromTitle: r.from_title || '',
  fromDate: r.from_date || null,
  fromContent: r.from_content || '',
  toUrl: r.to_url || '',
  foundAt: r.found_at
})

export const getMentions = async (db, domain) => {
  const rows = await db.prepare(
    'SELECT from_source, from_post, from_title, from_date, from_content, to_url, found_at FROM mentions WHERE to_domain=? ORDER BY found_at DESC LIMIT 100'
  ).bind(domain).all()
  return rows.results.map(toMention)
}

// Every row, grouped by domain, each group newest first like getMentions.
// Paged by id so no one result gets huge: a few queries total, not one per domain.
export const getAllMentionRows = async (db, pageSize = 500) => {
  const byDomain = new Map()
  let after = 0
  for (;;) {
    const { results } = await db.prepare(
      'SELECT id, from_source, from_post, from_title, from_date, from_content, to_domain, to_url, found_at FROM mentions WHERE id > ? ORDER BY id LIMIT ?'
    ).bind(after, pageSize).all()
    for (const r of results) {
      if (!byDomain.has(r.to_domain)) byDomain.set(r.to_domain, [])
      byDomain.get(r.to_domain).push(r)
    }
    if (results.length < pageSize) break
    after = results[results.length - 1].id
  }
  for (const list of byDomain.values()) list.sort((a, b) => a.found_at < b.found_at ? 1 : a.found_at > b.found_at ? -1 : 0)
  return byDomain
}

// stored rows as the newest-100 mentions getMentions would return
export const newestMentions = (storedRows) => storedRows.slice(0, 100).map(toMention)

// Mentions of one specific page - what the footer embed asks for. Hits the
// to_domain index then matches loosely in js, so http/https/www/utm noise
// between the stored href and the browser's idea of the page doesn't matter.
// Lean public shape on purpose: just enough to render "Mentioned by".
export const getMentionsForUrl = async (db, pageUrl) => {
  const wanted = urlMatchKey(pageUrl)
  if (!wanted) return []
  const domain = bareHost(pageUrl)
  if (!domain) return []
  const all = await getMentions(db, domain)
  return all
    .filter(m => urlMatchKey(m.toUrl) === wanted)
    .map(m => ({
      url: m.fromPost,
      title: m.fromTitle || m.fromPost,
      date: m.fromDate || m.foundAt,
      source: bareHost(m.fromSource) || m.fromSource
    }))
}

// Diffs against the stored rows for this domain instead of delete-and-reinsert.
// (from_post, to_url) is UNIQUE - one post linking three of your posts is
// three mentions, and each diffs independently. Unchanged rows are not
// touched, which also keeps their original found_at.
const mentionKey = (post, url) => `${post}\n${url}`

// The diff as statements, split so a caller batching many domains can run
// every delete first - UNIQUE(from_post, to_url) spans domains.
export const mentionStatements = (db, domain, storedRows, mentions) => {
  const wanted = new Map(mentions.map(m => [mentionKey(m.fromPost, m.toUrl || ''), m]))
  const deletes = []
  const updates = []
  const inserts = []
  const present = new Set()
  for (const row of storedRows) {
    const key = mentionKey(row.from_post, row.to_url || '')
    const m = wanted.get(key)
    if (!m) {
      deletes.push(db.prepare('DELETE FROM mentions WHERE to_domain=? AND from_post=? AND to_url=?').bind(domain, row.from_post, row.to_url || ''))
      continue
    }
    present.add(key)
    const changed =
      (row.from_source || '') !== (m.fromSource || '') ||
      (row.from_title || '') !== (m.fromTitle || '') ||
      (row.from_date || null) !== (m.fromDate || null) ||
      (row.from_content || '') !== (m.fromContent || '')
    if (changed) {
      updates.push(db.prepare(
        'UPDATE mentions SET from_source=?, from_title=?, from_date=?, from_content=? WHERE to_domain=? AND from_post=? AND to_url=?'
      ).bind(m.fromSource, m.fromTitle || null, m.fromDate || null, m.fromContent || null, domain, m.fromPost, m.toUrl || ''))
    }
  }
  for (const [key, m] of wanted) {
    if (present.has(key)) continue
    inserts.push(db.prepare(
      'INSERT INTO mentions (from_source, from_post, from_title, from_date, from_content, to_domain, to_url) VALUES (?,?,?,?,?,?,?)'
    ).bind(m.fromSource, m.fromPost, m.fromTitle || null, m.fromDate || null, m.fromContent || null, domain, m.toUrl || ''))
  }
  return { deletes, updates, inserts }
}

export const saveMentions = async (db, domain, mentions) => {
  const stored = await db.prepare(
    'SELECT from_source, from_post, from_title, from_date, from_content, to_url FROM mentions WHERE to_domain=?'
  ).bind(domain).all()
  const { deletes, updates, inserts } = mentionStatements(db, domain, stored.results, mentions)
  const stmts = [...deletes, ...updates, ...inserts]
  if (stmts.length) await db.batch(stmts)
}

// { [domain]: count } — live from mentions table, never stale.
// Counts posts, not rows: one post linking your homepage and a post is one mention.
export const getSourceMentionCounts = async (db) => {
  const rows = await db.prepare('SELECT to_domain, COUNT(DISTINCT from_post) AS cnt FROM mentions GROUP BY to_domain').all()
  const counts = {}
  for (const row of rows.results) {
    counts[row.to_domain] = row.cnt // eslint-disable-line camelcase
  }
  return counts
}
