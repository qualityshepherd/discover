export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

export const parseJsonBody = async (req) => {
  try { return await req.json() } catch { return null }
}

export const xmlAttr = (s) => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const isClickThrough = (posts) => {
  if (!posts?.length) return false
  return !posts.some(p => {
    const text = (p.content || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
    return text.length > 100
  })
}
