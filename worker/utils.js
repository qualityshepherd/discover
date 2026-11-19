export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

export const parseJsonBody = async (req) => {
  try { return await req.json() } catch { return null }
}

export const xmlAttr = (s) => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// the one spelling of a feed url we store: trimmed, no trailing slash. the
// curate path once kept "/feed/" while refresh stripped it, so one feed lived
// under two keys and the playlist's copy was never fetched
export const cleanFeedUrl = u => String(u || '').trim().replace(/\/+$/, '')

// hostname without www, '' for anything that isn't a url
export const bareHost = u => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase() } catch { return '' } }

// a feed isn't always on its blog's domain (feedburner, feedpress). the blog
// is its site url, else where its posts live, else the feed's own host
export const blogDomain = (feedUrl, data) =>
  bareHost(data?.siteUrl) || bareHost(data?.posts?.find(p => p.url)?.url) || bareHost(feedUrl)

// a feed already in discover from the same blog, by domain with www
// stripped - /feed vs /rss.xml, http vs https, www or not. returns that
// feed's url. misses blogs whose feed lives elsewhere (feedburner); rare.
export const sameBlog = (url, existingUrls) => {
  const target = bareHost(url)
  if (!target) return null
  return (existingUrls || []).find(u => bareHost(u) === target) || null
}
