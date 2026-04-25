const makeId = (url) => {
  const s = String(url).replace(/\/+$/, '')
  let h = 0
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0
  return Math.abs(h).toString(36)
}

export const injectMentionsLinks = (container, mentionCounts = {}) => {
  container.querySelectorAll('.feed-post[data-feed-url]').forEach(post => {
    const feedUrl = post.dataset.feedUrl
    if (!feedUrl) return
    const meta = post.querySelector('.feed-meta')
    if (!meta || meta.querySelector('.btn-mentions')) return
    const sourceId = makeId(feedUrl)
    const count = mentionCounts[sourceId]
    const a = document.createElement('a')
    a.href = `/api/mentions/${sourceId}.xml`
    a.className = 'btn-mentions'
    a.title = 'Subscribe to mentions of this source'
    a.textContent = count ? `↩ ${count}` : '↩ mentions'
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    meta.appendChild(a)
  })
}
