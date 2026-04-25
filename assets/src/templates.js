import { stripHtml, blurb, extractFirstImage } from './feedRules.js'

const formatDate = (dateStr) => {
  try {
    return new Date(dateStr).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' })
  } catch { return dateStr }
}

const feedDomain = (url) => {
  try { return new URL(url).hostname } catch { return '' }
}

const thumbPlaceholder = (label) => {
  const letter = (label || '?')[0].toUpperCase()
  const hue = [...(label || '')].reduce((h, c) => h + c.charCodeAt(0), 0) % 360
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"><rect width="120" height="120" fill="hsl(${hue},25%,22%)"/><text x="60" y="78" font-size="56" font-family="sans-serif" fill="hsl(${hue},40%,65%)" text-anchor="middle">${letter}</text></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

const safeUrl = (url) => {
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:' ? url : ''
  } catch { return '' }
}

export const feedsItemTemplate = (item) => {
  const url = safeUrl(item.url)
  const domain = feedDomain(url)
  const avatar = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : ''
  const dateStr = formatDate(item.date)
  const thumb = extractFirstImage(item.content || '') || thumbPlaceholder(item.feed?.title || domain)
  const text = blurb(item.content || '')

  const sourceName = `${item.author ? `${item.author} · ` : ''}${item.feed?.title || domain}`
  const playlistBadge = item.fromPlaylist && item.fromPlaylistId
    ? `<a class="feed-playlist-badge" href="/discover/${item.fromPlaylistId}">in: ${item.fromPlaylist}</a>`
    : ''

  return `
  <div class="post feed-post" data-url="${url}" data-feed-url="${safeUrl(item.feed?.url || '')}">
    <div class="feed-meta">
      ${avatar ? `<img class="feed-avatar" src="${avatar}" alt="" onerror="this.style.display='none'">` : ''}
      ${url
        ? `<a class="feed-source-name" href="${url}" target="_blank" rel="noopener noreferrer" title="${sourceName}">${sourceName}</a>`
        : `<span class="feed-source-name" title="${sourceName}">${sourceName}</span>`}
      <span class="date">${dateStr}</span>
    </div>
    <div class="feed-body feed-open">
      <img class="feed-thumb" src="${thumb}" alt="" loading="lazy">
      <div class="feed-body-text">
        ${item.title ? `<h2 class="post-title">${stripHtml(item.title)}</h2>` : ''}
        ${text ? `<p class="feed-blurb">${text}</p>` : ''}
      </div>
    </div>
    ${playlistBadge}
  </div>
  `
}
