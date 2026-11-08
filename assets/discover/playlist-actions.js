export const rssCopyBtnHtml = (id) =>
  `<button class="btn btn-sm btn-rss-copy" data-rss-id="${id}" title="Copy RSS feed URL">rss</button>`

export const handleRssCopy = async (btn, id) => {
  const url = `${location.origin}/api/discover/${id}/rss`
  await navigator.clipboard.writeText(url).catch(() => {})
  btn.textContent = 'copied!'
  setTimeout(() => { btn.textContent = 'rss' }, 1500)
}

export const opmlLinkHtml = (id) =>
  `<a class="btn btn-sm" href="/api/discover/${id}/opml" title="Download OPML">opml</a>`

export const linkCopyBtnHtml = (id) =>
  `<button class="btn btn-sm btn-link-copy" data-link-id="${id}" title="Copy playlist link">link</button>`

// rss link for one blog inside a feed - just its own url, no follow state
export const injectSourceRssButtons = (container) => {
  container.querySelectorAll('.feed-post').forEach(post => {
    const feedUrl = post.dataset.feedUrl
    if (!feedUrl) return
    const meta = post.querySelector('.feed-meta')
    if (!meta) return
    const rssBtn = document.createElement('button')
    rssBtn.className = 'btn btn-sm btn-source-rss'
    rssBtn.dataset.rssUrl = feedUrl
    rssBtn.title = feedUrl
    rssBtn.textContent = 'rss'
    meta.appendChild(rssBtn)
  })
}
