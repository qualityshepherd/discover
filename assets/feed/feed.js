import { feedsItemTemplate } from '../src/templates.js'
import { openModal, initModal, resetModal, setFeedContext, getFeedItem } from '../discover/modal.js'
import { getFollows, getSourceFollows, hasSourceFollow, toggleSourceFollow, getCustomFeeds, addCustomFeed, hasCustomFeed, clearFollows, clearSourceFollows, clearCustomFeeds, clearFollowedPlaylists } from '../discover/follows.js'

let allPosts = []

const PAGE = 20
const CACHE_KEY = 'discover_feed_cache'
const CACHE_TTL = 42 * 60 * 1000

const readCache = () => {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY))
    if (c && Date.now() - c.ts < CACHE_TTL) return c.posts
  } catch {}
  return null
}

const writeCache = (posts) => {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ posts, ts: Date.now() })) } catch {}
}

const clearCache = () => localStorage.removeItem(CACHE_KEY)

const renderPosts = () => {
  const container = document.getElementById('feed-posts')
  if (!allPosts.length) {
    container.innerHTML = '<p class="muted">no posts found.</p>'
    return
  }

  resetModal()
  setFeedContext(allPosts)
  initModal()

  let rendered = 0
  container.innerHTML = ''

  const renderMore = () => {
    const batch = allPosts.slice(rendered, rendered + PAGE)
    if (!batch.length) return
    const frag = document.createElement('div')
    frag.innerHTML = batch.map(p => feedsItemTemplate({ ...p, fromPlaylist: null, fromPlaylistId: null })).join('')
    container.appendChild(frag)
    rendered += batch.length
  }

  renderMore()

  const sentinel = document.createElement('div')
  container.appendChild(sentinel)
  const observer = new IntersectionObserver(entries => {
    if (!entries[0].isIntersecting) return
    if (rendered >= allPosts.length) { observer.disconnect(); sentinel.remove(); return }
    renderMore()
  }, { rootMargin: '200px' })
  observer.observe(sentinel)
}

const load = async () => {
  const follows = getFollows()
  const sourceFollows = getSourceFollows()
  const customFeeds = getCustomFeeds()
  const container = document.getElementById('feed-posts')

  if (!follows.length && !sourceFollows.length && !customFeeds.length) {
    allPosts = []
    container.innerHTML = '<p class="muted">follow sources from <a href="/">discover</a>, add your favorite feed or import an OPML file.</p>'
    return
  }

  const cached = readCache()
  if (cached) { allPosts = cached; renderPosts(); return }

  container.innerHTML = '<p class="muted">loading…</p>'

  let apiPosts = []
  if (follows.length || sourceFollows.length) {
    const res = await fetch('/api/discover/feed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: follows, sources: sourceFollows })
    })
    if (res.ok) {
      const data = await res.json()
      apiPosts = data.posts || []
    }
  }

  const customPosts = customFeeds
    .filter(f => f.posts?.length)
    .flatMap(f => f.posts.map(p => ({ ...p, fromSource: f.url, fromPlaylist: f.title })))

  allPosts = [...apiPosts, ...customPosts].sort((a, b) => new Date(b.date) - new Date(a.date))
  writeCache(allPosts)
  renderPosts()
}

document.getElementById('feed-posts').addEventListener('click', e => {
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
  a.download = 'feed.opml'
  a.click()
  URL.revokeObjectURL(a.href)
})

const opmlInput = document.getElementById('input-opml')
document.getElementById('btn-import-opml').addEventListener('click', () => opmlInput.click())
opmlInput.addEventListener('change', async () => {
  const file = opmlInput.files[0]
  if (!file) return
  opmlInput.value = ''
  const text = await file.text()
  const doc = new DOMParser().parseFromString(text, 'text/xml')
  const urls = [...doc.querySelectorAll('outline[xmlUrl]')].map(el => el.getAttribute('xmlUrl')).filter(Boolean)
  let added = 0
  for (const url of urls) {
    if (!hasSourceFollow(url)) { toggleSourceFollow(url); added++ }
  }
  if (added) { clearCache(); load() }
})

document.getElementById('btn-clear-feed').addEventListener('click', () => {
  if (!confirm('Clear everything from your feed?')) return
  clearFollows()
  clearSourceFollows()
  clearCustomFeeds()
  clearFollowedPlaylists()
  clearCache()
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

    fetch('/api/discover/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    }).catch(() => {})

    clearCache()
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

// publish feed (only shown when slug is set)
const slug = localStorage.getItem('discover_slug')
const publishBtn = document.getElementById('btn-publish-feed')
const publishStatus = document.getElementById('publish-status')
const publishLink = document.getElementById('publish-link')

if (slug) {
  publishBtn.classList.remove('hidden')
  publishLink.href = `${location.origin}/feed/${slug}.xml`
  publishLink.classList.remove('hidden')
}

publishBtn.addEventListener('click', async () => {
  const token = localStorage.getItem('discover_token')
  if (!token || !slug) return
  publishBtn.disabled = true
  publishBtn.textContent = '…'
  publishStatus.textContent = ''
  publishStatus.className = 'feed-add-status'
  try {
    const res = await fetch(`/api/feed/${slug}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ids: getFollows(), sources: getSourceFollows(), customFeeds: getCustomFeeds() })
    })
    if (res.ok) {
      publishStatus.textContent = 'published'
      publishStatus.className = 'feed-add-status ok'
      setTimeout(() => { publishStatus.textContent = ''; publishStatus.className = 'feed-add-status' }, 3000)
    } else {
      publishStatus.textContent = 'publish failed'
      publishStatus.className = 'feed-add-status error'
    }
  } catch {
    publishStatus.textContent = 'something went wrong'
    publishStatus.className = 'feed-add-status error'
  } finally {
    publishBtn.disabled = false
    publishBtn.textContent = 'publish'
  }
})

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
