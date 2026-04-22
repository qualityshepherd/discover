// KV key constants

export const KV_FEEDS = 'discover:feeds' // legacy — migration only
export const KV_INDEX = 'discover:index' // ordered list of feed IDs
export const KV_PREFIX = 'discover:feed:' // one entry per mix
export const KV_SOURCE_INDEX = 'discover:source-index' // { hash: { url, lastFetched } }
export const KV_SOURCE_PREFIX = 'discover:source:' // one entry per unique RSS URL
export const KV_PENDING = 'discover:pending'
export const KV_BLOCKED = 'discover:blocked'

// Stable short hash used as a KV key suffix for any URL

export const makeId = (url) => {
  const s = String(url).replace(/\/+$/, '')
  let h = 0
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0
  return Math.abs(h).toString(36)
}

// Mix KV helpers

export const getFeed = (kv, id) => kv.get(`${KV_PREFIX}${id}`, { type: 'json' })

export const saveFeed = (kv, feed) => kv.put(`${KV_PREFIX}${feed.id}`, JSON.stringify(feed))

export const getIndex = async (kv) => (await kv.get(KV_INDEX, { type: 'json' })) || []

// Read all feeds. Auto-migrates from legacy single-key format on first call.
export const getFeeds = async (kv) => {
  const legacy = await kv.get(KV_FEEDS, { type: 'json' })
  if (legacy?.length) {
    await Promise.all([
      ...legacy.map(f => saveFeed(kv, f)),
      kv.put(KV_INDEX, JSON.stringify(legacy.map(f => f.id))),
      kv.delete(KV_FEEDS)
    ])
    return legacy
  }
  const ids = await getIndex(kv)
  if (!ids.length) return []
  const feeds = await Promise.all(ids.map(id => getFeed(kv, id)))
  return feeds.filter(Boolean)
}

export const addToIndex = async (kv, id) => {
  const ids = await getIndex(kv)
  if (!ids.includes(id)) await kv.put(KV_INDEX, JSON.stringify([...ids, id]))
}

export const removeFromIndex = async (kv, id) => {
  const ids = await getIndex(kv)
  await kv.put(KV_INDEX, JSON.stringify(ids.filter(i => i !== id)))
}

// Source KV helpers

export const getSourceData = (kv, url) => kv.get(`${KV_SOURCE_PREFIX}${makeId(url)}`, { type: 'json' })
export const saveSourceData = (kv, url, data) => kv.put(`${KV_SOURCE_PREFIX}${makeId(url)}`, JSON.stringify(data))
export const deleteSourceData = async (kv, url) => {
  const hash = makeId(url)
  const index = await getSourceIndex(kv)
  delete index[hash]
  await Promise.all([kv.put(KV_SOURCE_INDEX, JSON.stringify(index)), kv.delete(`${KV_SOURCE_PREFIX}${hash}`)])
}
export const getSourceIndex = async (kv) => (await kv.get(KV_SOURCE_INDEX, { type: 'json' })) || {}

// Curator KV helpers

export const KV_CURATOR_PREFIX = 'curator:'
export const KV_CURATOR_INDEX = 'discover:curator-index'

export const getCurator = (kv, pubkey) => kv.get(`${KV_CURATOR_PREFIX}${pubkey}`, { type: 'json' })

export const saveCurator = (kv, pubkey, data) => kv.put(`${KV_CURATOR_PREFIX}${pubkey}`, JSON.stringify(data))

export const getCuratorIndex = async (kv) => (await kv.get(KV_CURATOR_INDEX, { type: 'json' })) || []

export const addToCuratorIndex = async (kv, pubkey) => {
  const index = await getCuratorIndex(kv)
  if (!index.includes(pubkey)) await kv.put(KV_CURATOR_INDEX, JSON.stringify([...index, pubkey]))
}

export const deleteCurator = async (kv, pubkey) => {
  const index = await getCuratorIndex(kv)
  await Promise.all([
    kv.delete(`${KV_CURATOR_PREFIX}${pubkey}`),
    kv.put(KV_CURATOR_INDEX, JSON.stringify(index.filter(p => p !== pubkey)))
  ])
}

export const listCurators = async (kv) => {
  const index = await getCuratorIndex(kv)
  if (!index.length) return []
  const curators = await Promise.all(index.map(async pubkey => {
    const c = await getCurator(kv, pubkey)
    return c ? { pubkey, ...c } : null
  }))
  return curators.filter(Boolean)
}

// Pure logic helpers — no KV

export const isCuratorOf = (curator, playlistId) => !!(curator && curator.playlistId === playlistId)

export const shouldUpdateLastSeen = (curator, now = Date.now()) =>
  !curator?.lastSeen || now - new Date(curator.lastSeen).getTime() > 24 * 60 * 60 * 1000

export const isCuratorInactive = (curator, now = Date.now()) =>
  !!(curator?.lastSeen && now - new Date(curator.lastSeen).getTime() > 180 * 24 * 60 * 60 * 1000)

// Pending / blocked helpers

export const getPending = (kv) => kv.get(KV_PENDING, { type: 'json' }) || []
export const getBlocked = (kv) => kv.get(KV_BLOCKED, { type: 'json' }) || []

export const isBlocked = async (kv, sources) => {
  const blocked = await getBlocked(kv) || []
  if (!blocked.length) return false
  return sources.some(url => {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '')
      return blocked.some(b => url.includes(b) || host.includes(b))
    } catch { return false }
  })
}

// Tag aggregation

export const computeTags = (feeds) => {
  const counts = {}
  for (const f of feeds) {
    for (const tag of (f.tags || [])) {
      counts[tag] = (counts[tag] || 0) + 1
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => ({ tag, count }))
}
