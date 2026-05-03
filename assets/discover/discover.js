import { feedsItemTemplate } from '../src/templates.js'
import { openModal, initModal, resetModal, setFeedContext, getFeedItem } from './modal.js'
import { renderTag, renderCard } from './render.js'
import { toggleFollow, hasFollow, followBtnHtml, rssCopyBtnHtml, handleRssCopy, syncFollowButtons, initFollowHover, hasSourceFollow, toggleSourceFollow, removeSourceFollow, syncSourceFollowButtons, injectSourceFollowButtons, hasFollowedPlaylist, addFollowedPlaylist, removeFollowedPlaylist } from './follows.js'
import { injectMentionsLinks } from './mentions.js'

// browse view

let allEntries = []
let allTags = []
let activeTags = new Set()
let playlistEntry = null
let mentionCounts = {}

let tagCloudExpanded = false

const renderTagCloud = (tags) => {
  const tagCloud = document.getElementById('tag-cloud')
  const visible = tagCloudExpanded ? tags : tags.slice(0, 18)
  const moreBtn = tags.length > 18
    ? `<button class="discover-tag discover-tag-more">${tagCloudExpanded ? '-less' : `+${tags.length - 18} more`}</button>`
    : ''
  tagCloud.innerHTML = visible.map(({ tag }) => renderTag(tag, activeTags.has(tag))).join('') + moreBtn
}

const shuffle = (arr) => {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const renderBrowse = (entries, tags) => {
  renderTagCloud(tags)

  const cards = document.getElementById('discover-cards')
  if (!entries.length) {
    cards.innerHTML = '<p class="muted">no feeds found.</p>'
    return
  }
  const featured = entries.filter(e => e.featured)
  const rest = shuffle(entries.filter(e => !e.featured))
  cards.innerHTML = [...featured, ...rest].map(renderCard).join('')
}

const filterAndRender = () => {
  closeDrawer()
  const search = document.getElementById('discover-search').value.toLowerCase()
  let results = allEntries
  if (activeTags.size) results = results.filter(e => [...activeTags].every(t => e.tags?.includes(t)))
  if (search) {
    results = results.filter(e =>
      e.title.toLowerCase().includes(search) ||
      e.description?.toLowerCase().includes(search) ||
      e.tags?.some(t => t.includes(search)) ||
      (e.sources || []).some(s => s.toLowerCase().includes(search))
    )
  }
  renderTagCloud(allTags)

  const cards = document.getElementById('discover-cards')
  cards.innerHTML = results.length ? results.map(renderCard).join('') : '<p class="muted">no feeds found.</p>'
  syncUrl()
}

const syncUrl = () => {
  const params = new URLSearchParams()
  if (activeTags.size) params.set('tag', [...activeTags].join(','))
  const q = document.getElementById('discover-search').value.trim()
  if (q) params.set('q', q)
  const qs = params.toString()
  history.replaceState({}, '', qs ? `/?${qs}` : '/')
}

const loadBrowse = async () => {
  window.scrollTo(0, 0)
  showView('browse')

  const params = new URLSearchParams(location.search)
  const tagParam = params.get('tag')
  const qParam = params.get('q')
  activeTags = new Set()
  if (tagParam) tagParam.split(',').filter(Boolean).forEach(t => activeTags.add(t))
  if (qParam) document.getElementById('discover-search').value = qParam

  const res = await fetch('/api/discover')
  const data = await res.json()
  allEntries = data.feeds || []
  allTags = data.tags || []
  mentionCounts = data.mentionCounts || {}

  renderBrowse(allEntries, data.tags || [])
  if (activeTags.size || qParam) filterAndRender()
}

const onFeedClick = (e) => {
  const trigger = e.target.closest('.feed-open')
  if (!trigger) return
  const post = trigger.closest('.feed-post')
  const item = getFeedItem(post.dataset.url)
  if (item) openModal(item)
}

// inline drawer

let activeDrawerId = null

const closeDrawer = () => {
  document.querySelector('.discover-drawer')?.remove()
  document.querySelector('.discover-card.expanded')?.classList.remove('expanded')
  resetModal()
  activeDrawerId = null
}

const openDrawer = async (id) => {
  if (activeDrawerId === id) { closeDrawer(); return }
  closeDrawer()
  activeDrawerId = id

  const card = document.querySelector(`.discover-card[data-id="${id}"]`)
  if (!card) return
  card.classList.add('expanded')

  const entrySources = allEntries.find(e => e.id === id)?.sources || []

  const drawer = document.createElement('div')
  drawer.className = 'discover-drawer'
  drawer.dataset.id = id
  drawer.innerHTML = `
    <div class="discover-drawer-actions">
      ${followBtnHtml(id, entrySources)}
      ${rssCopyBtnHtml(id)}
      <button class="btn btn-sm btn-link-copy" data-link-id="${id}" title="Copy playlist link">link</button>
      <button class="discover-drawer-close btn btn-sm" aria-label="Close">✕</button>
    </div>
    <div class="discover-drawer-feed"><p class="muted">loading…</p></div>
  `
  card.after(drawer)
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' })

  const feedEl = drawer.querySelector('.discover-drawer-feed')

  const res = await fetch(`/api/discover/${id}`)
  if (!res.ok) { feedEl.innerHTML = '<p class="muted">could not load feed.</p>'; return }
  const posts = await res.json()

  if (!posts.length) { feedEl.innerHTML = '<p class="muted">no posts found.</p>'; return }

  setFeedContext(posts)
  feedEl.innerHTML = posts.map(feedsItemTemplate).join('')
  injectSourceFollowButtons(feedEl)
  injectMentionsLinks(feedEl, mentionCounts)
  initModal()

  feedEl.addEventListener('click', onFeedClick)
}

// full playlist view (direct URL navigation only)

const loadPlaylist = async (id) => {
  window.scrollTo(0, 0)
  showView('playlist')
  const el = document.getElementById('playlist-feed')
  el.innerHTML = '<p class="muted">loading…</p>'

  let entry = allEntries.find(e => e.id === id)
  if (!entry) {
    const data = await fetch('/api/discover').then(r => r.json())
    allEntries = data.feeds || []
    allTags = data.tags || []
    entry = allEntries.find(e => e.id === id)
  }

  if (entry) {
    playlistEntry = entry
    document.getElementById('playlist-title').textContent = entry.title
    document.getElementById('playlist-description').textContent = entry.description || ''
    document.getElementById('playlist-tags').innerHTML = [
      ...(entry.tags || []).map(t => renderTag(t)),
      entry.author?.name ? `<span class="discover-author">${entry.author.url ? `<a href="${entry.author.url}" target="_blank" rel="noopener noreferrer">${entry.author.name}</a>` : entry.author.name}</span>` : ''
    ].join('')
    const rssBtn = document.getElementById('btn-rss-playlist')
    rssBtn.href = `/api/discover/${id}/rss`
    const followBtn = document.getElementById('btn-follow-playlist')
    const sources = entry.sources || []
    const followed = sources.length ? hasFollowedPlaylist(id) : hasFollow(id)
    followBtn.className = `btn btn-sm btn-follow${followed ? ' following' : ''}`
    followBtn.dataset.followId = id
    if (sources.length) followBtn.dataset.sources = sources.join('|')
    followBtn.textContent = followed ? 'following' : '+ follow'
  }

  const res = await fetch(`/api/discover/${id}`)
  if (!res.ok) { el.innerHTML = '<p class="muted">could not load feed.</p>'; return }
  const posts = await res.json()
  if (!posts.length) { el.innerHTML = '<p class="muted">no posts found.</p>'; return }

  setFeedContext(posts)
  el.innerHTML = posts.map(feedsItemTemplate).join('')
  injectSourceFollowButtons(el)
  initModal()
}

// routing

const showView = (name) => {
  document.getElementById('view-browse').classList.toggle('hidden', name !== 'browse')
  document.getElementById('view-playlist').classList.toggle('hidden', name !== 'playlist')
}

const ensureMentionCounts = async () => {
  if (Object.keys(mentionCounts).length) return
  const data = await fetch('/api/discover').then(r => r.json()).catch(() => ({}))
  mentionCounts = data.mentionCounts || {}
}

const loadNew = async () => {
  fetch('/api/hit?path=/new', { method: 'POST' }).catch(() => {})
  showView('browse')
  const cards = document.getElementById('discover-cards')
  cards.innerHTML = '<p class="muted">loading…</p>'
  document.getElementById('tag-cloud').innerHTML = ''
  await ensureMentionCounts()
  const posts = await fetch('/api/discover/new').then(r => r.json()).catch(() => [])
  if (!posts.length) { cards.innerHTML = '<p class="muted">no new posts yet.</p>'; return }
  const withLabel = posts.map(p => ({
    ...p,
    feed: { ...p.feed, title: p.feed?.title ? `${p.feed.title} · ${p.fromPlaylist}` : p.fromPlaylist }
  }))
  setFeedContext(withLabel)
  initModal()

  let rendered = 0
  const PAGE = 20

  cards.innerHTML = ''
  // sentinel sits at the bottom; items are inserted before it so it stays at
  // the end. IntersectionObserver fires when it enters the viewport to load the next batch.
  const sentinel = document.createElement('div')
  cards.appendChild(sentinel)

  const renderMore = () => {
    const batch = withLabel.slice(rendered, rendered + PAGE)
    if (!batch.length) return
    const frag = document.createElement('div')
    frag.innerHTML = batch.map(feedsItemTemplate).join('')
    cards.insertBefore(frag, sentinel)
    injectSourceFollowButtons(frag)
    injectMentionsLinks(frag, mentionCounts)
    rendered += batch.length
  }

  renderMore()
  const observer = new IntersectionObserver(entries => {
    if (!entries[0].isIntersecting) return
    if (rendered >= withLabel.length) { observer.disconnect(); sentinel.remove(); return }
    renderMore()
  }, { rootMargin: '200px' })
  observer.observe(sentinel)
}

const loadRandom = async () => {
  fetch('/api/hit?path=/random', { method: 'POST' }).catch(() => {})
  showView('browse')
  const cards = document.getElementById('discover-cards')
  cards.innerHTML = '<p class="muted">loading…</p>'
  document.getElementById('tag-cloud').innerHTML = ''
  await ensureMentionCounts()
  const posts = await fetch('/api/discover/random').then(r => r.json()).catch(() => [])
  const withPlaylist = posts.map(p => ({
    ...p,
    feed: { ...p.feed, title: p.feed?.title ? `${p.feed.title} · ${p.fromPlaylist}` : p.fromPlaylist }
  }))
  cards.innerHTML = withPlaylist.length ? withPlaylist.map(feedsItemTemplate).join('') : '<p class="muted">no posts found.</p>'
  if (withPlaylist.length) { injectSourceFollowButtons(cards); injectMentionsLinks(cards, mentionCounts) }
  setFeedContext(withPlaylist)
  initModal()
}

const route = () => {
  const path = location.pathname
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 2 && parts[0] === 'discover') {
    loadPlaylist(parts[1])
  } else if (path === '/new') {
    loadNew()
  } else if (path === '/random') {
    loadRandom()
  } else {
    loadBrowse()
  }
}

// events

document.getElementById('discover-search').addEventListener('input', () => filterAndRender())

document.getElementById('btn-random').addEventListener('click', (e) => {
  e.preventDefault()
  history.pushState({}, '', '/random')
  loadRandom()
})

document.getElementById('btn-new').addEventListener('click', (e) => {
  e.preventDefault()
  history.pushState({}, '', '/new')
  loadNew()
})

document.getElementById('tag-cloud').addEventListener('click', e => {
  const btn = e.target.closest('.discover-tag')
  if (!btn) return
  if (btn.classList.contains('discover-tag-more')) {
    tagCloudExpanded = !tagCloudExpanded
    renderTagCloud(allTags)
    return
  }
  const tag = btn.dataset.tag
  if (activeTags.has(tag)) activeTags.delete(tag)
  else activeTags.add(tag)
  filterAndRender()
})

document.getElementById('discover-cards').addEventListener('click', e => {
  if (e.target.closest('.discover-drawer-close')) {
    closeDrawer()
    return
  }

  const feedOpen = e.target.closest('.feed-open')
  if (feedOpen) {
    const post = feedOpen.closest('.feed-post')
    const item = getFeedItem(post?.dataset.url)
    if (item) openModal(item)
    return
  }

  const followBtn = e.target.closest('.btn-follow')
  if (followBtn && followBtn.id !== 'btn-follow-playlist') {
    if (followBtn.dataset.sources) {
      const id = followBtn.dataset.followId
      const sources = followBtn.dataset.sources.split('|').filter(Boolean)
      if (hasFollowedPlaylist(id)) {
        removeFollowedPlaylist(id)
        sources.forEach(url => removeSourceFollow(url))
      } else {
        addFollowedPlaylist(id)
        sources.forEach(url => { if (!hasSourceFollow(url)) toggleSourceFollow(url) })
      }
    } else {
      toggleFollow(followBtn.dataset.followId)
    }
    syncFollowButtons()
    syncSourceFollowButtons()
    return
  }

  const sourceFollowBtn = e.target.closest('.btn-source-follow')
  if (sourceFollowBtn) {
    toggleSourceFollow(sourceFollowBtn.dataset.sourceUrl)
    syncSourceFollowButtons()
    return
  }

  const rssBtn = e.target.closest('.btn-rss-copy')
  if (rssBtn) {
    handleRssCopy(rssBtn, rssBtn.dataset.rssId)
    return
  }

  const linkBtn = e.target.closest('.btn-link-copy')
  if (linkBtn) {
    const url = `${location.origin}/discover/${linkBtn.dataset.linkId}`
    navigator.clipboard.writeText(url).catch(() => {})
    linkBtn.textContent = 'copied!'
    setTimeout(() => { linkBtn.textContent = 'link' }, 1500)
    return
  }

  const tagBtn = e.target.closest('.discover-tag')
  if (tagBtn) {
    const tag = tagBtn.dataset.tag
    if (activeTags.has(tag)) activeTags.delete(tag)
    else activeTags.add(tag)
    filterAndRender()
    return
  }

  const titleLink = e.target.closest('.discover-card-title')
  if (titleLink) {
    e.preventDefault()
    titleLink.blur()
    const id = titleLink.closest('.discover-card').dataset.id
    openDrawer(id)
  }
})

document.getElementById('btn-follow-playlist').addEventListener('click', (e) => {
  if (!playlistEntry) return
  const btn = e.currentTarget
  const id = playlistEntry.id
  if (btn.dataset.sources) {
    const sources = btn.dataset.sources.split('|').filter(Boolean)
    if (hasFollowedPlaylist(id)) {
      removeFollowedPlaylist(id)
      sources.forEach(url => removeSourceFollow(url))
    } else {
      addFollowedPlaylist(id)
      sources.forEach(url => { if (!hasSourceFollow(url)) toggleSourceFollow(url) })
    }
    syncFollowButtons()
    syncSourceFollowButtons()
  } else {
    toggleFollow(id)
    syncFollowButtons()
  }
})

document.getElementById('btn-rss-playlist').addEventListener('click', (e) => {
  e.preventDefault()
  handleRssCopy(e.currentTarget, e.currentTarget.dataset.rssId || playlistEntry?.id)
})

document.getElementById('playlist-tags').addEventListener('click', e => {
  const btn = e.target.closest('.discover-tag')
  if (!btn) return
  const tag = btn.dataset.tag
  history.pushState({}, '', `/?tag=${encodeURIComponent(tag)}`)
  loadBrowse()
})

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && activeDrawerId) closeDrawer()
})

window.addEventListener('popstate', route)

document.getElementById('playlist-feed').addEventListener('click', onFeedClick)

// theme toggle

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

// init

initFollowHover()
route()
