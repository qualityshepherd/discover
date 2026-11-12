import { feedsItemTemplate } from '../src/templates.js'
import { openModal, initModal, resetModal, setFeedContext, getFeedItem } from './modal.js'
import { renderTag, renderCard } from './render.js'
import { handleRssCopy, injectSourceRssButtons } from './playlist-actions.js'
import { injectMentionsLinks } from './mentions.js'

// Avatar images (feed favicons) hide themselves on load failure instead of
// showing a broken-image icon. error events don't bubble, so this has to be
// a capture-phase listener on document rather than a normal delegated one -
// catches it regardless of which module (here or modal.js) rendered the img.
// A CSP that blocks inline handlers means this can't just be onerror="...".
document.addEventListener('error', (e) => {
  if (e.target.classList?.contains('feed-avatar')) e.target.style.display = 'none'
}, true)

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

let postTags = []
const ensurePostTags = async () => {
  if (postTags.length) return
  postTags = await fetch('/api/discover/tags').then(r => r.json()).catch(() => [])
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

// null = export everything, an array = export exactly this. only Filters
// and Tag set this - New/Random don't bother, button's hidden there anyway
let filteredItems = null

const setFilteredItems = (items) => {
  filteredItems = items
  document.getElementById('btn-export').textContent = items === null ? 'export (all)' : `export (${items.length})`
}

// search only makes sense on Filters. export makes sense anywhere you're
// looking at a set you actually built - Filters or a single tag - but not
// New/Random, that's just whatever scroll/shuffle position you landed on
const showHeader = (search, exportBtn) => {
  document.getElementById('discover-header').classList.toggle('hidden', !search && !exportBtn)
  document.getElementById('discover-search').classList.toggle('hidden', !search)
  document.getElementById('btn-export').classList.toggle('hidden', !exportBtn)
}

const feedDomain = (url) => {
  try { return new URL(url).hostname } catch { return '' }
}

const postsToOpmlItems = (posts) => {
  const seen = new Set()
  const items = []
  for (const p of posts) {
    const url = p.feed?.url
    if (!url || seen.has(url)) continue
    seen.add(url)
    items.push({ title: p.feed?.title || feedDomain(url), url })
  }
  return items
}

const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const downloadOpml = (items, filename) => {
  const outlines = items.map(({ title, url }) => `    <outline type="rss" text="${escXml(title)}" xmlUrl="${escXml(url)}"/>`).join('\n')
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="1.0">\n  <head><title>discover</title></head>\n  <body>\n${outlines}\n  </body>\n</opml>`
  const blob = new Blob([xml], { type: 'text/x-opml' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

const filterAndRender = async () => {
  closeDrawer()
  const q = document.getElementById('discover-search').value.trim()
  syncUrl()

  const cards = document.getElementById('discover-cards')

  if (q || activeTags.size) {
    cards.innerHTML = '<p class="muted">searching…</p>'
    const params = new URLSearchParams()
    if (q) params.set('q', q)
    if (activeTags.size) params.set('tag', [...activeTags][0])
    const results = await fetch(`/api/discover/search?${params}`).then(r => r.json()).catch(() => [])
    let filtered = results
    if (activeTags.size > 1) {
      filtered = results.filter(s =>
        [...activeTags].every(tag => (s.playlists || []).some(p => (p.tags || []).includes(tag)))
      )
    }
    renderTagCloud(allTags)
    if (!filtered.length) { cards.innerHTML = '<p class="muted">no results.</p>'; setFilteredItems([]); return }
    const seenUrls = new Set()
    const deduped = filtered.filter(s => !seenUrls.has(s.url) && seenUrls.add(s.url))
    cards.innerHTML = deduped.map(feedsItemTemplate).join('')
    injectSourceRssButtons(cards)
    injectMentionsLinks(cards, mentionCounts)
    setFeedContext(filtered)
    initModal()
    setFilteredItems(postsToOpmlItems(deduped))
    return
  }

  renderTagCloud(allTags)
  cards.innerHTML = allEntries.length ? allEntries.map(renderCard).join('') : '<p class="muted">no feeds found.</p>'
  setFilteredItems(null)
}

const syncUrl = () => {
  const params = new URLSearchParams()
  if (activeTags.size) params.set('tag', [...activeTags].join(','))
  const q = document.getElementById('discover-search').value.trim()
  if (q) params.set('q', q)
  const qs = params.toString()
  history.replaceState({}, '', qs ? `/filters?${qs}` : '/filters')
}

const loadBrowse = async () => {
  window.scrollTo(0, 0)
  showView('browse')
  showHeader(true, true)
  setFilteredItems(null)

  const params = new URLSearchParams(location.search)
  const tagParam = params.get('tag')
  const qParam = params.get('q')
  activeTags = new Set()
  if (tagParam) tagParam.split(',').filter(Boolean).forEach(t => activeTags.add(t))
  if (qParam) document.getElementById('discover-search').value = qParam

  const [res] = await Promise.all([fetch('/api/discover'), ensurePostTags()])
  const data = await res.json()
  allEntries = data.feeds || []
  allTags = data.tags || []
  mentionCounts = data.mentionCounts || {}

  renderBrowse(allEntries, postTags.length ? postTags : data.tags || [])
  if (activeTags.size || qParam) await filterAndRender()
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

  const drawer = document.createElement('div')
  drawer.className = 'discover-drawer'
  drawer.dataset.id = id
  drawer.innerHTML = `
    <div class="discover-drawer-actions">
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
  injectSourceRssButtons(feedEl)
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

  let entry = allEntries.find(e => e.id === id || e.slug === id)
  if (!entry) {
    const data = await fetch('/api/discover').then(r => r.json())
    allEntries = data.feeds || []
    mentionCounts = data.mentionCounts || mentionCounts
    allTags = data.tags || []
    entry = allEntries.find(e => e.id === id || e.slug === id)
  }

  if (entry) {
    playlistEntry = entry
    document.getElementById('playlist-title').textContent = entry.title
    document.getElementById('playlist-description').textContent = entry.description || ''
    document.getElementById('playlist-tags').innerHTML = (entry.tags || []).map(t => renderTag(t)).join('')
    document.getElementById('btn-rss-playlist').href = `/api/discover/${id}/rss`
    document.getElementById('btn-opml-playlist').href = `/api/discover/${id}/opml`
  }

  const res = await fetch(`/api/discover/${id}`)
  if (!res.ok) { el.innerHTML = '<p class="muted">could not load feed.</p>'; return }
  const posts = await res.json()
  if (!posts.length) { el.innerHTML = '<p class="muted">no posts found.</p>'; return }

  setFeedContext(posts)
  el.innerHTML = posts.map(feedsItemTemplate).join('')
  injectSourceRssButtons(el)
  injectMentionsLinks(el, mentionCounts)
  initModal()
}

// routing

const showView = (name) => {
  document.getElementById('view-browse').classList.toggle('hidden', name !== 'browse')
  document.getElementById('view-playlist').classList.toggle('hidden', name !== 'playlist')
}

const ensureMentionCounts = async () => {
  if (Object.keys(mentionCounts).length && allTags.length) return
  const data = await fetch('/api/discover').then(r => r.json()).catch(() => ({}))
  mentionCounts = data.mentionCounts || mentionCounts
  if (!allTags.length) allTags = data.tags || []
}

const NEW_PAGE = 20

const loadNew = async () => {
  fetch('/api/hit?path=/new', { method: 'POST' }).catch(() => {})
  showView('browse')
  showHeader(false, false)
  const cards = document.getElementById('discover-cards')
  document.getElementById('tag-cloud').innerHTML = ''
  cards.innerHTML = '<p class="muted">loading…</p>'
  await ensureMentionCounts()

  let loadedPosts = []
  let cursor = null
  let done = false
  let fetching = false

  const sentinel = document.createElement('div')

  const appendPage = (posts) => {
    loadedPosts = loadedPosts.concat(posts)
    // let the modal's own prev/next fetch the next page itself once you
    // read past what's loaded so far - reading via arrow keys never
    // scrolls the sentinel into view, so the IntersectionObserver below
    // never fires on its own
    setFeedContext(loadedPosts, done ? null : fetchPage)
    initModal()
    const frag = document.createElement('div')
    frag.innerHTML = posts.map(feedsItemTemplate).join('')
    cards.insertBefore(frag, sentinel)
    injectSourceRssButtons(frag)
    injectMentionsLinks(frag, mentionCounts)
  }

  const fetchPage = async () => {
    if (fetching || done) return
    fetching = true
    const params = new URLSearchParams({ limit: NEW_PAGE })
    if (cursor) params.set('before', cursor)
    const data = await fetch(`/api/discover/new?${params}`).then(r => r.json()).catch(() => ({ posts: [], nextCursor: null }))
    fetching = false
    cursor = data.nextCursor
    if (!data.nextCursor) done = true

    if (!data.posts.length) {
      if (!loadedPosts.length) cards.innerHTML = '<p class="muted">no new posts yet.</p>'
      return
    }
    if (!loadedPosts.length) cards.innerHTML = ''
    if (!cards.contains(sentinel)) cards.appendChild(sentinel)
    appendPage(data.posts)
  }

  await fetchPage()

  const observer = new IntersectionObserver(entries => {
    if (!entries[0].isIntersecting || done) return
    fetchPage()
  }, { rootMargin: '200px' })
  observer.observe(sentinel)
}

const loadRandom = async () => {
  fetch('/api/hit?path=/random', { method: 'POST' }).catch(() => {})
  showView('browse')
  showHeader(false, false)
  const cards = document.getElementById('discover-cards')
  cards.innerHTML = '<p class="muted">loading…</p>'
  document.getElementById('tag-cloud').innerHTML = ''
  await ensureMentionCounts()
  const posts = await fetch('/api/discover/random').then(r => r.json()).catch(() => [])
  const withPlaylist = posts
  cards.innerHTML = withPlaylist.length ? withPlaylist.map(feedsItemTemplate).join('') : '<p class="muted">no posts found.</p>'
  if (withPlaylist.length) { injectSourceRssButtons(cards); injectMentionsLinks(cards, mentionCounts) }
  setFeedContext(withPlaylist)
  initModal()
}

const loadTag = async (tag) => {
  fetch(`/api/hit?path=/tag/${encodeURIComponent(tag)}`, { method: 'POST' }).catch(() => {})
  showView('browse')
  showHeader(false, true)
  const cards = document.getElementById('discover-cards')
  cards.innerHTML = '<p class="muted">loading…</p>'
  await Promise.all([ensureMentionCounts(), ensurePostTags()])
  activeTags = new Set([tag])
  renderTagCloud(postTags.length ? postTags : allTags)
  const posts = await fetch(`/api/discover/tag/${encodeURIComponent(tag)}`).then(r => r.json()).catch(() => [])
  if (!posts.length) { cards.innerHTML = `<p class="muted">no posts tagged #${tag} yet.</p>`; setFilteredItems([]); return }
  setFeedContext(posts)
  initModal()
  cards.innerHTML = posts.map(feedsItemTemplate).join('')
  injectSourceRssButtons(cards)
  injectMentionsLinks(cards, mentionCounts)
  setFilteredItems(postsToOpmlItems(posts))
}

const route = () => {
  const path = location.pathname
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 2 && parts[0] === 'discover') {
    loadPlaylist(parts[1])
  } else if (parts.length === 2 && parts[0] === 'tag') {
    loadTag(decodeURIComponent(parts[1]))
  } else if (path === '/filters') {
    loadBrowse()
  } else if (path === '/random') {
    loadRandom()
  } else {
    loadNew()
  }
}

// events

let searchDebounce = null
document.getElementById('discover-search').addEventListener('input', () => {
  clearTimeout(searchDebounce)
  searchDebounce = setTimeout(filterAndRender, 300)
})

document.getElementById('btn-export').addEventListener('click', (e) => {
  e.preventDefault()
  if (filteredItems === null) { location.href = '/api/discover/all/opml'; return }
  if (!filteredItems.length) return
  downloadOpml(filteredItems, 'discover.opml')
})

document.getElementById('tag-cloud').addEventListener('click', e => {
  const btn = e.target.closest('.discover-tag')
  if (!btn) return
  if (btn.classList.contains('discover-tag-more')) {
    tagCloudExpanded = !tagCloudExpanded
    renderTagCloud(postTags.length ? postTags : allTags)
    return
  }
  const tag = btn.dataset.tag
  history.pushState({}, '', `/tag/${encodeURIComponent(tag)}`)
  loadTag(tag)
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

  const sourceRssBtn = e.target.closest('.btn-source-rss')
  if (sourceRssBtn) {
    navigator.clipboard.writeText(sourceRssBtn.dataset.rssUrl).catch(() => {})
    sourceRssBtn.textContent = 'copied!'
    setTimeout(() => { sourceRssBtn.textContent = 'rss' }, 1500)
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

document.getElementById('btn-rss-playlist').addEventListener('click', (e) => {
  e.preventDefault()
  handleRssCopy(e.currentTarget, e.currentTarget.dataset.rssId || playlistEntry?.id)
})

document.getElementById('playlist-tags').addEventListener('click', e => {
  const btn = e.target.closest('.discover-tag')
  if (!btn) return
  const tag = btn.dataset.tag
  history.pushState({}, '', `/filters?tag=${encodeURIComponent(tag)}`)
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

route()
