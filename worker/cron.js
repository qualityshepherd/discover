import { getSourceData, getSourceDataBulk, saveSourceData, updateSourceMeta, getAllSourceUrls, getStaleSourceMeta } from './db-sources.js'
import { getFeeds, saveFeed } from './db-feeds.js'
import { getBlocked } from './db-moderation.js'
import { getCronState, setCronState } from './db-auth.js'
import { savePostTags } from './db-search.js'
import { fetchSource, computeFrequency, findImage, applySourceDatas, trimPosts } from './fetch-source.js'
import { buildLinkGraph } from './link-graph.js'
import { maybeBuildCurateCandidates } from './curate.js'

// 15 feeds x 3 worst-case fetches = 45, leaving room for the curate probes
const BATCH_SIZE = 15

export const checkDiscoverFeeds = async (env) => {
  const db = env.DISCOVER_DB
  const allFeeds = await getFeeds(db)
  if (!allFeeds?.length) return { processed: 0, skipped: 0 }

  const sourceMetas = await getStaleSourceMeta(db, { limit: BATCH_SIZE })
  const due = sourceMetas.map(m => ({ url: m.url, image: m.image, latestPostUrl: m.latestPostUrl }))

  const freshData = new Map()
  const now = Date.now()

  for (const entry of due) {
    const { url } = entry
    const result = await fetchSource(url, 20, env.DOMAIN_NAME)

    if (result.posts) {
      const frequency = computeFrequency(result.posts)
      const image = findImage(result.posts) || entry.image || null
      const posts = trimPosts(result.posts)
      const data = { url, siteUrl: result.siteUrl || null, posts, image, frequency, title: posts[0]?.feed?.title || null, statusCode: result.statusCode, error: null, lastFetched: new Date(now).toISOString() }
      await savePostTags(db, url, posts)
      await saveSourceData(db, url, data)
      freshData.set(url, data)
    } else {
      // fetch failed — update metadata only, leave posts untouched
      await updateSourceMeta(db, url, { statusCode: result.statusCode ?? 0, error: result.error || null, lastFetched: new Date(now).toISOString() })
      const existing = await getSourceData(db, url)
      if (existing) freshData.set(url, existing)
    }
  }

  // Recompute feeds that had sources updated OR have never been populated
  const updatedUrls = new Set(due.map(d => d.url))
  const needsUpdate = allFeeds.filter(f =>
    !f.previewPosts?.length ||
    (f.sources || []).some(s => updatedUrls.has(s))
  )

  // Bulk-fetch all source URLs needed for feed recomputation that aren't already in freshData
  const missingUrls = [...new Set(
    needsUpdate.flatMap(f => (f.sources || []).filter(u => !freshData.has(u)))
  )]
  const bulkFetched = await getSourceDataBulk(db, missingUrls)
  const getSource = (url) => freshData.has(url) ? freshData.get(url) : bulkFetched.get(url) || null

  const changedFeeds = []
  for (const feed of needsUpdate) {
    const sourceDatas = (feed.sources || []).map(getSource)
    if (!sourceDatas.filter(Boolean).length) continue
    applySourceDatas(feed, sourceDatas, { keepOnEmpty: true })
    feed.lastUpdated = new Date(now).toISOString()
    changedFeeds.push(feed)
  }
  // The cron only changes preview posts, cover image and frequency, so leave feed_sources and the FTS index alone
  if (changedFeeds.length) await Promise.all(changedFeeds.map(f => saveFeed(db, f, { syncChildren: false })))

  const allSourceUrls = await getAllSourceUrls(db)
  await buildLinkGraph(db, allSourceUrls, freshData).catch(err => console.error('buildLinkGraph failed:', err))
  await maybeBuildCurateCandidates(db, allSourceUrls, freshData, env.DOMAIN_NAME).catch(err => console.error('buildCurateCandidates failed:', err))

  await Promise.all([
    setCronState(db, 'cron:lastOk', new Date().toISOString()),
    setCronState(db, 'cron:lastCount', String(due.length))
  ])

  if (env.R2) {
    const today = new Date().toISOString().slice(0, 10)
    const lastBackup = await getCronState(db, 'cron:lastBackup')
    if (lastBackup !== today) {
      const [feeds, blocked] = await Promise.all([getFeeds(db), getBlocked(db)])
      await env.R2.put(`backup/discover-${today}.json`, JSON.stringify({ date: today, feeds: feeds || [], blocked: blocked || [] }), {
        httpMetadata: { contentType: 'application/json' }
      })
      await setCronState(db, 'cron:lastBackup', today)

      // Each snapshot is a full point-in-time copy, not incremental — only
      // the most recent is needed to restore, and a couple weeks of depth
      // covers damage that wasn't noticed immediately. No need to keep more.
      const BACKUP_RETENTION_DAYS = 14
      const cutoff = new Date(today)
      cutoff.setUTCDate(cutoff.getUTCDate() - BACKUP_RETENTION_DAYS)
      const cutoffKey = `backup/discover-${cutoff.toISOString().slice(0, 10)}.json`
      await env.R2.delete(cutoffKey).catch(err => console.error('Backup cleanup failed:', cutoffKey, err))
    }
  }

  return { processed: due.length, skipped: allSourceUrls.length - due.length }
}
