import { json, parseJsonBody, sameBlog } from './utils.js'
import { statsLine } from './feed-stats.js'
import { getAllSourceUrls } from './db-sources.js'
import { getPending, savePending, getCandidates, saveCandidates, addDismissedDomain } from './db-moderation.js'

// GET /api/discover/admin/curate
export const handleCurateGet = async (db) => {
  const [pending, candidates, sourceUrls] = await Promise.all([getPending(db), getCandidates(db), getAllSourceUrls(db)])
  const links = c => c.stats?.linksBack?.length || 0
  // rows with no feed are remembered failed probes, rejected ones are the
  // machine's soft no's - neither is a suggestion. link-backs first: a blog
  // that links back into the circle is already in the neighborhood
  const shown = candidates
    .filter(c => c.feedUrl && !c.rejected)
    .sort((a, b) => (links(b) - links(a)) || (a.score - b.score) || String(b.firstSeen || '').localeCompare(String(a.firstSeen || '')))
    .map(c => ({ ...c, line: statsLine(c.stats) }))
  return json({
    pending: pending.map(p => ({ ...p, line: statsLine(p.stats), duplicateOf: sameBlog(p.url, sourceUrls) })),
    candidates: shown
  })
}

// POST /api/discover/admin/curate/approve
export const handleCurateApprove = async (req, db) => {
  const body = await parseJsonBody(req)
  if (!body?.domain || !body?.feedUrl) return json({ error: 'domain and feedUrl required' }, 400)
  const [pending, candidates] = await Promise.all([getPending(db), getCandidates(db)])
  if (!pending.find(p => p.url === body.feedUrl)) {
    const stats = candidates.find(c => c.domain === body.domain)?.stats || null
    pending.push({ url: body.feedUrl, title: body.domain, description: '', submittedAt: new Date().toISOString(), stats })
  }
  await Promise.all([
    savePending(db, pending),
    saveCandidates(db, candidates.filter(c => c.domain !== body.domain))
  ])
  return json({ ok: true })
}

// DELETE /api/discover/admin/curate/candidate
export const handleCurateDismissCandidate = async (req, db) => {
  const body = await parseJsonBody(req)
  if (!body?.domain) return json({ error: 'domain required' }, 400)
  const candidates = await getCandidates(db)
  await Promise.all([
    saveCandidates(db, candidates.filter(c => c.domain !== body.domain)),
    addDismissedDomain(db, body.domain)
  ])
  return json({ ok: true })
}
