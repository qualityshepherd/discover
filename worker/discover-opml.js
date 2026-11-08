import { json, xmlAttr } from './utils.js'
import { getFeed, getFeeds } from './db-feeds.js'
import { getSourceData } from './db-sources.js'
import { EDGE_CACHE_CONTROL } from './cache.js'

export const toOpml = (feeds) => {
  const outlines = feeds.flatMap(f =>
    (f.sources || []).map(url =>
      `    <outline type="rss" text="${xmlAttr(f.title)}" xmlUrl="${xmlAttr(url)}"/>`
    )
  ).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="1.0">\n  <head><title>discover</title></head>\n  <body>\n${outlines}\n  </body>\n</opml>`
}

// GET /api/discover/:id/opml
export const handleOpml = async (db, id, reqUrl) => {
  let entry
  if (id === 'all') {
    const feeds = await getFeeds(db) || []
    entry = { title: 'discover', sources: [...new Set(feeds.flatMap(f => f.sources || []))] }
  } else {
    entry = await getFeed(db, id)
    if (entry?.slug && entry.slug !== id) return Response.redirect(new URL(`/api/discover/${entry.slug}/opml`, reqUrl), 301)
  }
  if (!entry) return json({ error: 'not found' }, 404)

  return new Response(toOpml([entry]), {
    headers: {
      'Content-Type': 'text/x-opml',
      'Content-Disposition': `attachment; filename="discover-${id}.opml"`
    }
  })
}

// GET /api/discover/:id/rss
export const handlePlaylistRss = async (db, id, reqUrl) => {
  const entry = await getFeed(db, id)
  if (!entry) return json({ error: 'not found' }, 404)
  if (entry.slug && entry.slug !== id) return Response.redirect(new URL(`/api/discover/${entry.slug}/rss`, reqUrl), 301)

  const sourceDatas = await Promise.all((entry.sources || []).map(url => getSourceData(db, url)))
  const posts = sourceDatas
    .filter(Boolean)
    .flatMap(s => s.posts || [])
    .sort((a, b) => new Date(b.date) - new Date(a.date))

  const base = new URL(reqUrl).origin
  const items = posts.map(p => `
    <item>
      <title>${xmlAttr(p.title)}</title>
      <link>${xmlAttr(p.url)}</link>
      <guid>${xmlAttr(p.url)}</guid>
      ${p.date ? `<pubDate>${new Date(p.date).toUTCString()}</pubDate>` : ''}
      ${p.author || p.feed?.title ? `<author>${xmlAttr(p.author || p.feed?.title)}</author>` : ''}
      ${p.feed?.title ? `<source url="${xmlAttr(p.feed.url)}">${xmlAttr(p.feed.title)}</source>` : ''}
    </item>`).join('')

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${xmlAttr(entry.title)} · discover</title>
    <description>${xmlAttr(entry.description)}</description>
    <link>${base}/discover/${id}</link>
    ${items}
  </channel>
</rss>`

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': EDGE_CACHE_CONTROL
    }
  })
}
