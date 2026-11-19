import { json, parseJsonBody, sameBlog } from './utils.js'
import { statsLine } from './feed-stats.js'
import { getAllSourceUrls, getSourceData } from './db-sources.js'
import { getPending, savePending, getCandidates, saveCandidates, addDismissedDomain } from './db-moderation.js'
import { VIDEO_DOMAINS } from './discover-cron.js'

// GET /api/discover/admin/webping
export const handleWebping = async (db) => {
  const allSourceUrls = await getAllSourceUrls(db)

  const sourceDomains = new Map()
  for (const url of allSourceUrls) {
    try { sourceDomains.set(new URL(url).hostname, url) } catch {}
  }

  const sourceDatas = await Promise.all(allSourceUrls.map(u => getSourceData(db, u)))

  const matches = []
  for (let i = 0; i < allSourceUrls.length; i++) {
    const data = sourceDatas[i]
    if (!data?.posts) continue
    const fromDomain = (() => { try { return new URL(allSourceUrls[i]).hostname } catch { return null } })()
    for (const post of data.posts) {
      if (!post.content) continue
      const hrefs = [...post.content.matchAll(/href=["']([^"']+)["']/g)].map(m => m[1])
      for (const href of hrefs) {
        try {
          const domain = new URL(href).hostname
          if (domain === fromDomain) continue
          if (VIDEO_DOMAINS.has(domain)) continue
          if (sourceDomains.has(domain)) {
            matches.push({ from: allSourceUrls[i], post: post.url, postTitle: post.title, linksTo: href, targetSource: sourceDomains.get(domain) })
          }
        } catch {}
      }
    }
  }

  return json({ sources: allSourceUrls.length, matches })
}

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
