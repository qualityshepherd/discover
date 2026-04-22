const KEY = 'discover_follows'

export const getFollows = () => {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]') } catch { return [] }
}

const saveFollows = (ids) => localStorage.setItem(KEY, JSON.stringify(ids))

export const hasFollow = (id) => getFollows().includes(id)

export const clearFollows = () => localStorage.removeItem(KEY)

export const addFollow = (id) => {
  const follows = getFollows()
  if (!follows.includes(id)) saveFollows([...follows, id])
}

export const removeFollow = (id) => saveFollows(getFollows().filter(f => f !== id))

export const toggleFollow = (id) => { hasFollow(id) ? removeFollow(id) : addFollow(id) }

export const followBtnHtml = (id, sources = []) => {
  const followed = sources.length
    ? getSourceFollows().some(url => sources.includes(url))
    : hasFollow(id)
  const sourcesAttr = sources.length ? ` data-sources="${sources.join('|')}"` : ''
  return `<button class="btn btn-sm btn-follow${followed ? ' following' : ''}" data-follow-id="${id}"${sourcesAttr}>${followed ? 'in my feed' : '+ my feed'}</button>`
}

export const rssCopyBtnHtml = (id) =>
  `<button class="btn btn-sm btn-rss-copy" data-rss-id="${id}" title="Copy RSS feed URL">rss</button>`

export const handleRssCopy = async (btn, id) => {
  const url = `${location.origin}/api/discover/${id}/rss`
  await navigator.clipboard.writeText(url).catch(() => {})
  btn.textContent = 'copied!'
  setTimeout(() => { btn.textContent = 'rss' }, 1500)
}

export const syncFollowButtons = () => {
  document.querySelectorAll('.btn-follow[data-follow-id]').forEach(btn => {
    let followed
    if (btn.dataset.sources) {
      const sources = btn.dataset.sources.split('|')
      followed = getSourceFollows().some(url => sources.includes(url))
    } else {
      followed = hasFollow(btn.dataset.followId)
    }
    btn.classList.toggle('following', followed)
    btn.textContent = followed ? 'in my feed' : '+ my feed'
  })
}

// source-level follows (individual RSS feed URLs)

const SOURCE_KEY = 'discover_source_follows'

export const getSourceFollows = () => {
  try { return JSON.parse(localStorage.getItem(SOURCE_KEY) || '[]') } catch { return [] }
}

const saveSourceFollows = (urls) => localStorage.setItem(SOURCE_KEY, JSON.stringify(urls))

export const clearSourceFollows = () => localStorage.removeItem(SOURCE_KEY)

export const hasSourceFollow = (url) => getSourceFollows().includes(url)

export const removeSourceFollow = (url) => saveSourceFollows(getSourceFollows().filter(f => f !== url))

export const toggleSourceFollow = (url) => {
  const follows = getSourceFollows()
  saveSourceFollows(follows.includes(url) ? follows.filter(f => f !== url) : [...follows, url])
}

export const syncSourceFollowButtons = () => {
  document.querySelectorAll('.btn-source-follow[data-source-url]').forEach(btn => {
    const followed = hasSourceFollow(btn.dataset.sourceUrl)
    btn.classList.toggle('following', followed)
    btn.textContent = followed ? 'in my feed' : '+ my feed'
  })
}

export const injectSourceFollowButtons = (container) => {
  container.querySelectorAll('.feed-post').forEach(post => {
    const feedUrl = post.dataset.feedUrl
    if (!feedUrl) return
    const followed = hasSourceFollow(feedUrl)
    const btn = document.createElement('button')
    btn.className = `btn btn-sm btn-source-follow${followed ? ' following' : ''}`
    btn.dataset.sourceUrl = feedUrl
    btn.textContent = followed ? 'in my feed' : '+ my feed'
    post.querySelector('.feed-meta')?.appendChild(btn)
  })
}

// custom (user-added) feeds — stored with metadata in localStorage

const CUSTOM_KEY = 'discover_custom_feeds'

export const getCustomFeeds = () => {
  try { return JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]') } catch { return [] }
}

const saveCustomFeeds = (feeds) => localStorage.setItem(CUSTOM_KEY, JSON.stringify(feeds))

export const hasCustomFeed = (url) => getCustomFeeds().some(f => f.url === url)

export const addCustomFeed = (feed) => {
  const feeds = getCustomFeeds().filter(f => f.url !== feed.url)
  saveCustomFeeds([...feeds, { ...feed, addedAt: new Date().toISOString() }])
}

export const removeCustomFeed = (url) => saveCustomFeeds(getCustomFeeds().filter(f => f.url !== url))

export const clearCustomFeeds = () => localStorage.removeItem(CUSTOM_KEY)

export const initFollowHover = (root = document) => {
  root.addEventListener('mouseover', e => {
    const btn = e.target.closest('.btn-follow.following')
    if (btn) btn.textContent = 'remove'
  })
  root.addEventListener('mouseout', e => {
    const btn = e.target.closest('.btn-follow.following')
    if (btn) btn.textContent = 'in my feed'
  })
}
