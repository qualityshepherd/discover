import { followBtnHtml, rssCopyBtnHtml } from './follows.js'

export const renderTag = (tag, active = false) =>
  `<button class="discover-tag${active ? ' active' : ''}" data-tag="${tag}">#${tag}</button>`

const AVATAR_COLORS = ['#5878a8', '#5a8f6a', '#9e6848', '#7050a0', '#987c30', '#3a8888', '#9a4858', '#607838']

export const avatarColor = (str) => {
  let h = 0
  for (let i = 0; i < str.length; i++) h = Math.imul(31, h) + str.charCodeAt(i) | 0
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'in', 'and', 'for', 'to', 'by', 'with', 'at', 'on'])

export const avatarLetter = (title) =>
  title.split(/\s+/)
    .filter(w => !STOP_WORDS.has(w.toLowerCase()) && /[a-z]/i.test(w))
    .slice(0, 2)
    .map(w => w.charAt(0).toUpperCase())
    .join('')

export const renderCard = (entry) => {
  const sourceCount = (entry.sources || []).length
  const freq = entry.updateFrequency && entry.updateFrequency !== 'unknown' ? entry.updateFrequency : ''
  const color = avatarColor(entry.id)
  const letter = avatarLetter(entry.title)
  const coverImg = entry.coverImage
  const coverHtml = coverImg
    ? `<div class="discover-card-cover" aria-hidden="true"><img src="${coverImg}" alt="" loading="lazy"><div class="discover-card-cover-scrim"></div></div>`
    : ''
  return `
  <div class="discover-card" data-id="${entry.id}" data-letter="${letter}" style="--card-accent:${color}">
    ${coverHtml}
    <div class="discover-card-body">
      ${entry.featured ? '<span class="discover-featured">featured</span>' : ''}
      <a class="discover-card-title" href="/discover/${entry.id}">${entry.title}</a>
      ${entry.description ? `<div class="discover-card-desc">${entry.description}</div>` : ''}
      <div class="discover-card-meta">
        ${sourceCount ? `<span class="discover-type">${sourceCount} feeds</span>` : ''}
        ${freq ? `<span class="discover-freq">${freq}</span>` : ''}
        ${entry.author?.name ? `<span class="discover-author">${entry.author.url ? `<a href="${entry.author.url}" target="_blank" rel="noopener noreferrer">${entry.author.name}</a>` : entry.author.name}</span>` : ''}
      </div>
      ${(entry.tags || []).length ? `<div class="discover-tags">${(entry.tags || []).map(t => renderTag(t)).join('')}</div>` : ''}
      <div class="discover-card-actions">
        ${followBtnHtml(entry.id, entry.sources || [])}
        ${rssCopyBtnHtml(entry.id)}
      </div>
    </div>
  </div>`
}
