import { urlMatchKey } from './url-normalize.js'
import { bareHost } from './utils.js'

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

export const saveMentions = async (db, domain, mentions) => {
  const stored = await db.prepare(
    'SELECT from_source, from_post, from_title, from_date, from_content, to_url FROM mentions WHERE to_domain=?'
  ).bind(domain).all()

  const wanted = new Map(mentions.map(m => [mentionKey(m.fromPost, m.toUrl || ''), m]))
  const stmts = []
  const present = new Set()
  for (const row of stored.results) {
    const key = mentionKey(row.from_post, row.to_url || '')
    const m = wanted.get(key)
    if (!m) {
      stmts.push(db.prepare('DELETE FROM mentions WHERE to_domain=? AND from_post=? AND to_url=?').bind(domain, row.from_post, row.to_url || ''))
      continue
    }
    present.add(key)
    const changed =
      (row.from_source || '') !== (m.fromSource || '') ||
      (row.from_title || '') !== (m.fromTitle || '') ||
      (row.from_date || null) !== (m.fromDate || null) ||
      (row.from_content || '') !== (m.fromContent || '')
    if (changed) {
      stmts.push(db.prepare(
        'UPDATE mentions SET from_source=?, from_title=?, from_date=?, from_content=? WHERE to_domain=? AND from_post=? AND to_url=?'
      ).bind(m.fromSource, m.fromTitle || null, m.fromDate || null, m.fromContent || null, domain, m.fromPost, m.toUrl || ''))
    }
  }
  for (const [key, m] of wanted) {
    if (present.has(key)) continue
    stmts.push(db.prepare(
      'INSERT INTO mentions (from_source, from_post, from_title, from_date, from_content, to_domain, to_url) VALUES (?,?,?,?,?,?,?)'
    ).bind(m.fromSource, m.fromPost, m.fromTitle || null, m.fromDate || null, m.fromContent || null, domain, m.toUrl || ''))
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
