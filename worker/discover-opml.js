import { json, xmlAttr } from './utils.js'
import { getFeed, getFeeds } from './db-feeds.js'
import { getSourceData } from './db-sources.js'

export const toOpml = (feeds) => {
  const outlines = feeds.flatMap(f =>
    (f.sources || []).map(url =>
      `    <outline type="rss" text="${xmlAttr(f.title)}" xmlUrl="${xmlAttr(url)}"/>`
    )
  ).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="1.0">\n  <head><title>discover</title></head>\n  <body>\n${outlines}\n  </body>\n</opml>`
}

// GET /api/discover/:id/opml
export const handleOpml = async (db, id) => {
  let entry
  if (id === 'all') {
    const feeds = await getFeeds(db) || []
    entry = { title: 'discover', sources: feeds.flatMap(f => f.sources || []) }
  } else {
    entry = await getFeed(db, id)
  }
  if (!entry) return json({ error: 'not found' }, 404)

  return new Response(toOpml([entry]), {
    headers: {
      'Content-Type': 'text/x-opml',
      'Content-Disposition': `attachment; filename="discover-${id}.opml"`
    }
  })
}

// POST /api/discover/feed/opml
export const handleFeedOpml = async (db, req) => {
  const { ids = [], sources = [] } = await req.json().catch(() => ({}))
  const feeds = ids.length ? (await Promise.all(ids.map(id => getFeed(db, id)))).filter(Boolean) : []
  if (sources.length) feeds.push({ title: 'followed sources', sources })
  return new Response(toOpml(feeds), {
    headers: {
      'Content-Type': 'text/x-opml',
      'Content-Disposition': 'attachment; filename="feed.opml"'
    }
  })
}

// GET /api/discover/all/opml
export const handleAllOpml = async (db) => {
  const feeds = await getFeeds(db) || []
  return new Response(toOpml(feeds), {
    headers: {
      'Content-Type': 'text/x-opml',
      'Content-Disposition': 'attachment; filename="discover-all.opml"'
    }
  })
}

// GET /api/discover/:id/rss
export const handlePlaylistRss = async (db, id, reqUrl) => {
  const entry = await getFeed(db, id)
  if (!entry) return json({ error: 'not found' }, 404)

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
      'Cache-Control': 'no-store'
    }
  })
}
