import { processContent, embedToLazy } from '../src/feedRules.js'

let feedItems = new Map()
let feedList = []
let currentIndex = -1
let modalReady = false

// Called by discover.js after loading posts for a drawer or playlist
export const setFeedContext = (posts) => {
  feedList = posts
  feedItems = new Map(posts.map(p => [p.url, p]))
}

export const getFeedItem = (url) => feedItems.get(url)

export const resetModal = () => {
  closeModal()
  const existing = document.getElementById('feed-modal')
  existing?.remove()
  modalReady = false
  feedItems = new Map()
  feedList = []
  currentIndex = -1
}

export const closeModal = () => {
  const modal = document.getElementById('feed-modal')
  if (!modal) return
  modal.classList.add('hidden')
  document.documentElement.style.overflow = ''
  document.body.style.overflow = ''
  modal.querySelector('.feed-modal-body').innerHTML = ''
}

const feedDomain = (url) => { try { return new URL(url).hostname } catch { return '' } }

const renderModalItem = (modal, item) => {
  modal.querySelector('.feed-modal-title').textContent = item.title || ''
  const body = modal.querySelector('.feed-modal-body')
  const processed = item.content ? embedToLazy(processContent(item.content, item.feed?.url)) : ''
  body.innerHTML = processed ||
    `<p class="feed-modal-no-content">no preview available — <a href="${item.url || '#'}" target="_blank" rel="noopener noreferrer">read original →</a></p>`
  body.scrollTop = 0
  modal.querySelector('.feed-modal-original').href = item.url || '#'
  const subscribeEl = modal.querySelector('.feed-modal-subscribe')
  if (item.feed?.url) {
    subscribeEl.href = item.feed.url
    subscribeEl.classList.remove('hidden')
  } else {
    subscribeEl.classList.add('hidden')
  }
  modal.querySelector('.feed-modal-prev').disabled = currentIndex <= 0
  modal.querySelector('.feed-modal-next').disabled = currentIndex >= feedList.length - 1

  const sourceEl = modal.querySelector('.feed-modal-source')
  const domain = feedDomain(item.feed?.url || item.url || '')
  const favicon = domain ? `<img src="https://www.google.com/s2/favicons?domain=${domain}&sz=16" class="feed-avatar" alt="" onerror="this.style.display='none'">` : ''
  const feedName = item.feed?.title || domain || ''
  const playlist = item.fromPlaylist && item.fromPlaylistId
    ? ` · <a class="feed-modal-playlist" href="/discover/${item.fromPlaylistId}">${item.fromPlaylist}</a>`
    : ''
  sourceEl.innerHTML = feedName ? `${favicon}<span>${feedName}</span>${playlist}` : ''
}

const navigateTo = (index) => {
  if (index < 0 || index >= feedList.length) return
  currentIndex = index
  renderModalItem(document.getElementById('feed-modal'), feedList[index])
}

export const openModal = (item) => {
  currentIndex = feedList.findIndex(i => i.url === item.url)
  const modal = document.getElementById('feed-modal')
  renderModalItem(modal, item)
  modal.classList.remove('hidden')
  document.documentElement.style.overflow = 'hidden'
  document.body.style.overflow = 'hidden'
}

export const initModal = () => {
  if (modalReady) return
  modalReady = true

  const modal = document.createElement('div')
  modal.id = 'feed-modal'
  modal.className = 'feed-modal-overlay hidden'
  modal.innerHTML = `
    <div class="feed-modal">
      <div class="feed-modal-header">
        <button class="feed-modal-prev" aria-label="Previous">←</button>
        <span class="feed-modal-title"></span>
        <button class="feed-modal-next" aria-label="Next">→</button>
        <button class="feed-modal-close" aria-label="Close">✕</button>
      </div>
      <div class="feed-modal-body"></div>
      <div class="feed-modal-footer">
        <div class="feed-modal-source"></div>
        <div class="feed-modal-links">
          <a class="feed-modal-original" href="#" target="_blank" rel="noopener noreferrer">↗ website</a>
          <a class="feed-modal-subscribe hidden" href="#" target="_blank" rel="noopener noreferrer">rss</a>
        </div>
      </div>
    </div>
  `
  document.body.appendChild(modal)

  modal.querySelector('.feed-modal-close').addEventListener('click', closeModal)
  modal.querySelector('.feed-modal-prev').addEventListener('click', () => navigateTo(currentIndex - 1))
  modal.querySelector('.feed-modal-next').addEventListener('click', () => navigateTo(currentIndex + 1))
  modal.addEventListener('click', e => { if (e.target === modal) closeModal() })
  document.addEventListener('keydown', e => {
    if (modal.classList.contains('hidden')) return
    if (e.key === 'Escape') closeModal()
    if (e.key === 'ArrowRight') navigateTo(currentIndex + 1)
    if (e.key === 'ArrowLeft') navigateTo(currentIndex - 1)
  })

  let touchStartX = 0; let touchStartY = 0
  modal.addEventListener('touchstart', e => {
    touchStartX = e.touches[0].clientX; touchStartY = e.touches[0].clientY
  }, { passive: true })
  modal.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - touchStartX
    const dy = e.changedTouches[0].clientY - touchStartY
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
      dx < 0 ? navigateTo(currentIndex + 1) : navigateTo(currentIndex - 1)
    }
  }, { passive: true })

  modal.addEventListener('click', e => {
    const btn = e.target.closest('.video-play-btn')
    if (!btn) return
    const embed = btn.closest('.video-embed')
    embed.innerHTML = `<iframe src="${embed.dataset.src}" frameborder="0" allowfullscreen loading="lazy"></iframe>`
  })
}
