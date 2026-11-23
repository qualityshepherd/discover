// Public mentions endpoints: an RSS feed per blog, and the JSON the footer
// embed asks for. Both read the same mentions table.
import { json, xmlAttr } from './utils.js'
import { getMentions, getMentionsForUrl, getRecentMentionLinks } from './db-mentions.js'
import { EDGE_CACHE_CONTROL } from './cache.js'
import { urlMatchKey } from './url-normalize.js'

// GET /api/mentions/for?url=<post-url> - the footer embed's endpoint.
// CORS * on purpose: the snippet runs on other people's blogs, and this
// is public data (same rows the .xml feed publishes). Reeder gets the
// feed, footers get this - both read the same mentions table.
export const handleMentionsForUrl = async (db, reqUrl) => {
  const pageUrl = new URL(reqUrl).searchParams.get('url') || ''
  const mentions = await getMentionsForUrl(db, pageUrl)
  const res = json({ mentions })
  res.headers.set('Access-Control-Allow-Origin', '*')
  res.headers.set('Cache-Control', EDGE_CACHE_CONTROL)
  return res
}

// GET /api/mentions.json - what discover's curated blogs linked lately, for
// other indexes (bear, blogroll) to use. First-hand only: every row came
// from a feed curated here. Links, not words - no post bodies.
export const OUTBOUND_DAYS = 30
export const OUTBOUND_SPEC = 'https://discover.brine.dev/mentions-spec'

// some feeds double-escape, so hrefs got stored as &amp;amp;
const decodeAmp = (u) => {
  let s = u
  for (let i = 0; i < 5 && s.includes('&amp;'); i++) s = s.replace(/&amp;/g, '&')
  return s
}

const isoDate = (d) => {
  const t = Date.parse(d || '')
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

export const handleMentionsOutbound = async (db, now = Date.now()) => {
  const rows = await getRecentMentionLinks(db, now - OUTBOUND_DAYS * 86400000)
  const byPost = new Map()
  for (const r of rows) {
    const link = decodeAmp(r.to_url || '')
    if (!/^https?:\/\//i.test(link)) continue
    let p = byPost.get(r.from_post)
    if (!p) {
      p = { post: r.from_post, title: r.from_title || '', date: isoDate(r.from_date), links: [] }
      byPost.set(r.from_post, p)
    }
    if (!p.links.includes(link)) p.links.push(link)
  }
  const res = json({ version: 1, updated: new Date(now).toISOString(), days: OUTBOUND_DAYS, spec: OUTBOUND_SPEC, mentions: [...byPost.values()] })
  res.headers.set('Access-Control-Allow-Origin', '*')
  res.headers.set('Cache-Control', EDGE_CACHE_CONTROL)
  return res
}

// Only the newest mentions carry the other blog's full post, like any feed's
// window. Older ones are just a link - their words stay on their site.
export const MENTIONS_FEED_FULL = 20

// Rows are per (post, linked url); the feed is per post. Keeps the newest
// row's place, links the most specific page it pointed at (a post beats /).
export const onePerPost = (mentions) => {
  const byPost = new Map()
  for (const m of mentions) {
    const seen = byPost.get(m.fromPost)
    if (!seen) byPost.set(m.fromPost, m)
    else if ((urlMatchKey(m.toUrl) || '').length > (urlMatchKey(seen.toUrl) || '').length) {
      byPost.set(m.fromPost, { ...seen, toUrl: m.toUrl })
    }
  }
  return [...byPost.values()]
}

// GET /api/mentions/:sourceId.xml
export const handleMentionsFeed = async (db, sourceId, reqUrl) => {
  const items = onePerPost(await getMentions(db, sourceId))
  const domain = sourceId
  const base = new URL(reqUrl).origin

  const rssItems = items.map((m, i) => {
    // fromSource is their feed url; link their site, not raw xml
    const src = (() => { try { return new URL(m.fromSource) } catch { return null } })()
    const host = xmlAttr(src ? src.hostname : m.fromSource)
    const site = src ? src.origin : m.fromSource
    const who = `<a href="${site}">${host}</a> mentioned <a href="${m.toUrl}">${xmlAttr(domain)}</a>`
    const body = i < MENTIONS_FEED_FULL
      ? `<p>↩ ${who} in this post:</p>${m.fromContent || ''}`
      : `<p>↩ ${who}. <a href="${m.fromPost}">Read it on ${host}</a></p>`
    return `
    <item>
      <title>${xmlAttr(m.fromTitle || m.fromPost)}</title>
      <link>${xmlAttr(m.fromPost)}</link>
      <guid>${xmlAttr(m.fromPost)}</guid>
      <pubDate>${new Date(m.fromDate || m.foundAt).toUTCString()}</pubDate>
      <description><![CDATA[${body}]]></description>
    </item>`
  }).join('')

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Mentions of ${xmlAttr(domain)} · discover</title>
    <description>Posts from other discover sources that linked to ${xmlAttr(domain)}</description>
    <link>${base}/api/mentions/${sourceId}.xml</link>
    ${rssItems}
  </channel>
</rss>`

  return new Response(xml, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': EDGE_CACHE_CONTROL }
  })
}
