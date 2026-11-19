export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

export const parseJsonBody = async (req) => {
  try { return await req.json() } catch { return null }
}

export const xmlAttr = (s) => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// a feed already in discover from the same blog, by domain with www
// stripped - /feed vs /rss.xml, http vs https, www or not. returns that
// feed's url. misses blogs whose feed lives elsewhere (feedburner); rare.
export const sameBlog = (url, existingUrls) => {
  const h = u => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase() } catch { return '' } }
  const target = h(url)
  if (!target) return null
  return (existingUrls || []).find(u => h(u) === target) || null
}
