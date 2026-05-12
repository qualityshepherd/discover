export const injectMentionsLinks = (container, mentionCounts = {}) => {
  container.querySelectorAll('.feed-post[data-feed-url]').forEach(post => {
    const feedUrl = post.dataset.feedUrl
    if (!feedUrl || post.dataset.customFeed) return
    const meta = post.querySelector('.feed-meta')
    if (!meta || meta.querySelector('.btn-mentions')) return
    let sourceId
    try { sourceId = new URL(feedUrl).hostname.replace(/^www\./, '') } catch { sourceId = feedUrl }
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
