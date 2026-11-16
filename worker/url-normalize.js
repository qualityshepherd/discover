// Turns a URL into the key we match mentions on. The href a feed carried
// and the URL a browser reports for the same page rarely agree byte-for-byte
// (http/https, www, trailing slash, #fragment, utm junk) - this boils both
// down to the part that actually names the page. Stored to_urls stay raw
// and clickable; only matching happens through here.
const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'ref'])

export const urlMatchKey = (raw) => {
  let url
  try { url = new URL(raw) } catch { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null

  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const path = url.pathname.replace(/\/+$/, '')

  // real params (wordpress /?p=123) survive, tracking junk doesn't
  const params = [...url.searchParams]
    .filter(([k]) => !k.startsWith('utm_') && !TRACKING_PARAMS.has(k))
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  const query = params.length ? `?${new URLSearchParams(params)}` : ''

  return `${host}${path}${query}`
}
