import { feedsItemTemplate } from '../src/templates.js'
import { openModal, initModal, resetModal, setFeedContext, getFeedItem } from '../discover/modal.js'
import { getFollows, removeFollow, getSourceFollows, hasSourceFollow, toggleSourceFollow, removeSourceFollow, getCustomFeeds, addCustomFeed, removeCustomFeed, hasCustomFeed, clearFollows, clearSourceFollows, clearCustomFeeds, clearFollowedPlaylists } from '../discover/follows.js'

let allPosts = []
let allPlaylists = []
let activePlaylist = null

const injectRemoveButtons = (container) => {
  container.querySelectorAll('.feed-post').forEach(post => {
    const feedUrl = post.dataset.feedUrl
    if (!feedUrl) return
    const btn = document.createElement('button')
    btn.className = 'feed-post-remove'
    btn.dataset.removeUrl = feedUrl
    btn.title = 'remove from feed'
    btn.textContent = '✕'
    post.querySelector('.feed-meta')?.appendChild(btn)
  })
}

const renderPosts = () => {
  const container = document.getElementById('feed-posts')
  const posts = activePlaylist
    ? allPosts.filter(p => p.fromPlaylistId === activePlaylist || p.fromCustomFeedUrl === activePlaylist)
    : allPosts

  if (!posts.length) {
    container.innerHTML = '<p class="muted">no posts found.</p>'
    return
  }

  resetModal()
  setFeedContext(posts)
  container.innerHTML = posts.map(feedsItemTemplate).join('')
  injectRemoveButtons(container)
  initModal()
}

const renderPlaylistStrip = () => {
  const strip = document.getElementById('feed-playlist-strip')
  const sourceFollows = getSourceFollows()
  const customFeeds = getCustomFeeds()
  const chips = [
    ...allPlaylists.map(p => ({ id: p.id, title: p.title, type: 'playlist' })),
    ...sourceFollows.map(url => ({ id: url, title: new URL(url).hostname, type: 'source' })),
    ...customFeeds.map(f => ({ id: f.url, title: f.title, type: 'custom' }))
  ]
  if (!chips.length) { strip.classList.add('hidden'); return }
  strip.classList.remove('hidden')
  strip.innerHTML = chips.map(p =>
    `<button class="discover-tag feed-playlist-chip${activePlaylist === p.id ? ' active' : ''}" data-id="${p.id}" data-type="${p.type}">${p.title} <span class="feed-custom-remove" data-id="${p.id}" data-type="${p.type}" title="remove">✕</span></button>`
  ).join('')
}

const load = async () => {
  const follows = getFollows()
  const sourceFollows = getSourceFollows()
  const customFeeds = getCustomFeeds()
  const container = document.getElementById('feed-posts')

  if (!follows.length && !sourceFollows.length && !customFeeds.length) {
    allPlaylists = []
    allPosts = []
    renderPlaylistStrip()
    container.innerHTML = '<p class="muted">not following anything yet — <a href="/">browse discover</a> to follow some feeds, or paste a feed URL above.</p>'
    return
  }

  container.innerHTML = '<p class="muted">loading…</p>'

  let apiPosts = []
  if (follows.length || sourceFollows.length) {
    const params = new URLSearchParams()
    if (follows.length) params.set('ids', follows.join(','))
    if (sourceFollows.length) params.set('sources', sourceFollows.join(','))
    const res = await fetch(`/api/discover/feed?${params}`)
    if (res.ok) {
      const data = await res.json()
      // 1 post per source — my feed is for auditing, not reading
      const seen = new Set()
      apiPosts = (data.posts || []).filter(p => {
        const key = p.feed?.url || p.fromSource || p.url
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      allPlaylists = data.playlists || []
    }
  } else {
    allPlaylists = []
  }

  const customPosts = customFeeds
    .filter(f => f.posts?.length)
    .map(f => ({ ...f.posts[0], fromPlaylistId: f.url, fromCustomFeedUrl: f.url, fromPlaylist: f.title }))

  allPosts = [...apiPosts, ...customPosts].sort((a, b) => new Date(b.date) - new Date(a.date))

  renderPlaylistStrip()
  renderPosts()
}

document.getElementById('feed-playlist-strip').addEventListener('click', e => {
  const remove = e.target.closest('.feed-custom-remove')
  if (remove) {
    e.stopPropagation()
    const { id, type } = remove.dataset
    if (type === 'playlist') removeFollow(id)
    else if (type === 'source') toggleSourceFollow(id)
    else removeCustomFeed(id)
    if (activePlaylist === id) activePlaylist = null
    load()
    return
  }
  const chip = e.target.closest('.feed-playlist-chip')
  if (!chip) return
  const id = chip.dataset.id
  activePlaylist = activePlaylist === id ? null : id
  renderPlaylistStrip()
  renderPosts()
})

document.getElementById('feed-posts').addEventListener('click', e => {
  const removeBtn = e.target.closest('.feed-post-remove')
  if (removeBtn) {
    const url = removeBtn.dataset.removeUrl
    if (hasSourceFollow(url)) removeSourceFollow(url)
    if (hasCustomFeed(url)) removeCustomFeed(url)
    load()
    return
  }

  const feedOpen = e.target.closest('.feed-open')
  if (!feedOpen) return
  const post = feedOpen.closest('.feed-post')
  const item = getFeedItem(post?.dataset.url)
  if (item) openModal(item)
})

document.getElementById('btn-opml').addEventListener('click', async () => {
  const follows = getFollows()
  const sourceFollows = getSourceFollows()
  const customFeeds = getCustomFeeds()
  const allSources = [...sourceFollows, ...customFeeds.map(f => f.url)]
  if (!follows.length && !allSources.length) return
  const res = await fetch('/api/discover/feed/opml', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: follows, sources: allSources })
  })
  const blob = await res.blob()
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'my-feed.opml'
  a.click()
  URL.revokeObjectURL(a.href)
})

document.getElementById('btn-clear-feed').addEventListener('click', () => {
  if (!confirm('Clear everything from your feed?')) return
  clearFollows()
  clearSourceFollows()
  clearCustomFeeds()
  clearFollowedPlaylists()
  activePlaylist = null
  load()
})

// add custom feed by URL
const addUrlInput = document.getElementById('feed-add-url')
const addBtn = document.getElementById('btn-feed-add')
const addStatus = document.getElementById('feed-add-status')

const addFeedByUrl = async () => {
  const url = addUrlInput.value.trim().replace(/\/+$/, '')
  if (!url) return
  if (!URL.canParse(url)) { addStatus.textContent = 'not a valid url'; addStatus.className = 'feed-add-status error'; return }
  if (hasCustomFeed(url)) { addStatus.textContent = 'already in your feed'; addStatus.className = 'feed-add-status error'; return }

  addBtn.disabled = true
  addBtn.textContent = 'fetching…'
  addStatus.textContent = ''
  addStatus.className = 'feed-add-status'

  try {
    const res = await fetch('/api/discover/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    })
    const data = await res.json()
    if (!res.ok) {
      addStatus.textContent = data.error || 'could not load that feed'
      addStatus.className = 'feed-add-status error'
      return
    }
    addCustomFeed({ url, title: data.title, image: data.image, posts: data.posts, siteUrl: data.siteUrl })
    addUrlInput.value = ''
    addStatus.textContent = `added: ${data.title}`
    addStatus.className = 'feed-add-status ok'
    setTimeout(() => { addStatus.textContent = ''; addStatus.className = 'feed-add-status' }, 3000)

    // silently suggest to discover
    fetch('/api/discover/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    }).catch(() => {})

    load()
  } catch {
    addStatus.textContent = 'something went wrong'
    addStatus.className = 'feed-add-status error'
  } finally {
    addBtn.disabled = false
    addBtn.textContent = 'add'
  }
}

addBtn.addEventListener('click', addFeedByUrl)
addUrlInput.addEventListener('keydown', e => { if (e.key === 'Enter') addFeedByUrl() })

// theme
const themeBtn = document.getElementById('btn-theme')
const updateThemeBtn = () => {
  themeBtn.textContent = document.documentElement.dataset.theme === 'light' ? '☽' : '☀'
}
themeBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'
  document.documentElement.dataset.theme = next
  localStorage.setItem('discover_theme', next)
  updateThemeBtn()
})
updateThemeBtn()

load()
