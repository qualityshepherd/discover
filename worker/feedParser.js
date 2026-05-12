// RSS abuse is real! This is about that...

export const safeUrl = (url) => {
  if (!url) return ''
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    return url.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  } catch { return '' }
}

export const extractTag = (xml, tag) => {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return match ? match[1].trim() : ''
}

export const extractCdata = (str) => {
  const match = str.match(/<!\[CDATA\[([\s\S]*?)\]\]>/)
  return match ? match[1].trim() : str.trim()
}

const decodeEntities = (str) => str
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))

export const extractAttr = (xml, tag, attr) => {
  const match = xml.match(new RegExp(`<${tag}[^>]*${attr}=["']([^"']*)["'][^>]*>`, 'i'))
  return match ? match[1] : ''
}

// Extract all <category> values (RSS text content or Atom term= attr)
export const extractCategories = (xml) => {
  const cats = []
  for (const [, term] of xml.matchAll(/<category[^>]+term=["']([^"']+)["'][^>]*\/?>/gi)) cats.push(term)
  for (const m of xml.matchAll(/<category[^>]*>([^<]+)<\/category>/gi)) {
    if (!m[0].includes('term=')) cats.push(m[1].trim())
  }
  return cats
}

const HEX_COLOR = /^[0-9a-f]{3,8}$/i
const HEX_ENTITY = /^x[0-9a-f]+$/i // &#x2019; &#xa0; etc
const FOOTNOTE = /^fn(?:ref)?\d*$/i // fn1 fn2 fnref1 fnref2

// require # not preceded by & ( " ' = to avoid entities + markdown/html anchors
const CONTENT_TAG_RE = /(?<![&("'=])#([a-zA-Z][a-zA-Z0-9_-]*)/g

export const normalizeTag = (raw) => raw.toLowerCase().replace(/[^a-z0-9]/g, '')

export const extractPostTags = (categoryXml, content) => {
  const tags = new Set()
  for (const c of extractCategories(categoryXml)) {
    const n = normalizeTag(c.trim())
    if (n.length >= 2 && !HEX_COLOR.test(n) && !HEX_ENTITY.test(n) && !FOOTNOTE.test(n)) tags.add(n)
  }
  if (content) {
    const text = content.replace(/<[^>]*>/g, ' ')
    for (const [, t] of text.matchAll(CONTENT_TAG_RE)) {
      const n = normalizeTag(t)
      if (n.length >= 2 && !HEX_COLOR.test(n) && !HEX_ENTITY.test(n) && !FOOTNOTE.test(n)) tags.add(n)
    }
  }
  return [...tags].slice(0, 5)
}

export const isAtom = (xml) =>
  xml.includes('xmlns="http://www.w3.org/2005/Atom"') ||
  xml.trimStart().startsWith('<feed')

export const parseFeedTitle = (xml, url = '') => {
  const title = decodeEntities(extractCdata(extractTag(xml, 'title')))
  if (title) return title
  const tagMatch = url.match(/\/tags\/([^./]+)/)
  return tagMatch ? `#${tagMatch[1]}` : ''
}

// RSS

const splitItems = (xml) => {
  const items = []
  const re = /<item>([\s\S]*?)<\/item>/gi
  let match
  while ((match = re.exec(xml)) !== null) items.push(match[1])
  return items
}

const parseRssItem = (itemXml, feedMeta, isPodcast = false) => {
  const enclosureUrl = extractAttr(itemXml, 'enclosure', 'url')
  const enclosureType = extractAttr(itemXml, 'enclosure', 'type') || ''
  const isAudioEnclosure = enclosureType.startsWith('audio/')
  const isImageEnclosure = enclosureType.startsWith('image/')
  const content = extractCdata(
    extractTag(itemXml, 'content:encoded') || extractTag(itemXml, 'description')
  )
  const mediaUrl = extractAttr(itemXml, 'media:content', 'url')
  const imgUrl = (mediaUrl && !content.includes(mediaUrl))
    ? mediaUrl
    : (enclosureUrl && isImageEnclosure && !content.includes(enclosureUrl))
        ? enclosureUrl
        : ''
  const imgTag = imgUrl ? `<img src="${safeUrl(imgUrl)}" loading="lazy" style="max-width:100%;display:block;margin-top:0.5em;">` : ''
  const audioTag = enclosureUrl && isPodcast && isAudioEnclosure && !content.includes('<audio')
    ? `<audio controls src="${safeUrl(enclosureUrl)}" style="width:100%;margin-top:1em;"></audio>`
    : ''
  const rawTitle = decodeEntities(extractCdata(extractTag(itemXml, 'title')))
  const title = rawTitle || feedMeta.title || ''
  return {
    title,
    url: extractCdata(extractTag(itemXml, 'link')).replace(/<[^>]+>/g, '').trim(),
    date: extractTag(itemXml, 'pubDate') || extractTag(itemXml, 'dc:date') || '',
    content: content + imgTag + audioTag,
    author: extractCdata(extractTag(itemXml, 'dc:creator') || extractTag(itemXml, 'author')),
    tags: extractPostTags(itemXml, content),
    feed: feedMeta
  }
}

// Atom

const splitEntries = (xml) => {
  const entries = []
  const re = /<entry>([\s\S]*?)<\/entry>/gi
  let match
  while ((match = re.exec(xml)) !== null) entries.push(match[1])
  return entries
}

const parseAtomEntry = (entryXml, feedMeta) => {
  const videoId = extractCdata(extractTag(entryXml, 'yt:videoId'))
  const thumbnail = videoId
    ? `<a href="${safeUrl(`https://www.youtube.com/watch?v=${videoId}`)}" target="_blank" rel="noopener noreferrer"><img src="${safeUrl(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`)}" loading="lazy" style="max-width:100%;display:block;margin:0 auto;"></a>`
    : ''
  const content = extractCdata(extractTag(entryXml, 'content') || extractTag(entryXml, 'summary'))
  return {
    title: decodeEntities(extractCdata(extractTag(entryXml, 'title'))),
    url: extractAttr(entryXml, 'link', 'href') || extractCdata(extractTag(entryXml, 'link')),
    date: extractTag(entryXml, 'published') || extractTag(entryXml, 'updated') || '',
    content: thumbnail + content,
    author: extractCdata(extractTag(extractTag(entryXml, 'author'), 'name')),
    tags: extractPostTags(entryXml, content),
    feed: feedMeta
  }
}

// Public API

export const parseFeed = (xml, feedConfig) => {
  const feedMeta = { title: parseFeedTitle(xml, feedConfig.url), url: feedConfig.url }
  const isPodcast = xml.includes('xmlns:itunes')
  return isAtom(xml)
    ? splitEntries(xml).map(e => parseAtomEntry(e, feedMeta))
    : splitItems(xml).map(i => parseRssItem(i, feedMeta, isPodcast))
}

export const limitFeed = (posts, limit = 10) =>
  posts.slice(0, limit)

export const sortByDate = (posts) =>
  [...posts].sort((a, b) => new Date(b.date) - new Date(a.date))

export const aggregateFeeds = (feedResults) => {
  const all = feedResults.flatMap(({ posts, config: feedConfig }) =>
    limitFeed(posts, feedConfig.limit ?? 10)
  )
  const seen = new Set()
  const deduped = all.filter(p => {
    if (!p.url) return true
    if (seen.has(p.url)) return false
    seen.add(p.url)
    return true
  })
  return sortByDate(deduped)
}
