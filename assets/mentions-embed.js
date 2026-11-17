// One file, two ways in.
//
// Static blogs drop this at the bottom of a post template and posts other
// discover blogs have linked grow a "Mentioned by" list right where the
// tag sits. Renders nothing at all when there are no mentions:
//
//   <script src="https://discover.brine.dev/mentions-embed.js" defer></script>
//
// SPAs add data-manual to that same tag (a script injected via innerHTML
// never executes, so a client-rendered post can't use the auto flow) and
// call window.discoverMentions(el) after rendering a post - optionally
// with the post's url as a second arg when location isn't it.
//
// Rather not load a script from someone else's server? Fair. Copy this file
// to your own site and point it back here for the data:
//
//   <script src="/mentions-embed.js" data-api="https://discover.brine.dev" defer></script>
//
// Not comments... mentions.
(() => {
  const script = document.currentScript
  if (!script) return
  // data-api is for people who copy this file onto their own site instead
  // of loading it from here - otherwise it'd ask their server for mentions
  const api = new URL('/api/mentions/for', script.dataset.api || script.src)

  // the api is trusted today, but a feed's <link> is still third-party
  // input - and post-federation this is a real boundary. textContent
  // only, http(s) links only. returns null when nothing survives.
  const buildBox = (mentions) => {
    const box = document.createElement('div')
    box.className = 'discover-mentions'

    // announces as a heading to assistive tech without inheriting the
    // host's h2 drama - a real h2 renders post-title-sized on some blogs
    const heading = document.createElement('p')
    heading.setAttribute('role', 'heading')
    heading.setAttribute('aria-level', '2')
    heading.className = 'discover-mentions-heading'
    heading.textContent = 'Mentioned by'
    box.appendChild(heading)

    const list = document.createElement('ul')
    list.className = 'discover-mentions-list'
    for (const m of mentions) {
      let url
      try { url = new URL(m.url) } catch { continue }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
      const li = document.createElement('li')
      const a = document.createElement('a')
      a.href = url.href
      a.textContent = m.title
      a.rel = 'noopener'
      li.appendChild(a)
      li.appendChild(document.createTextNode(' · ' + m.source))
      list.appendChild(li)
    }
    if (!list.children.length) return null
    box.appendChild(list)
    return box
  }

  const render = (pageUrl, place) => {
    const req = new URL(api)
    req.searchParams.set('url', pageUrl)
    fetch(req)
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        const mentions = data && data.mentions
        if (!mentions || !mentions.length) return
        const box = buildBox(mentions)
        if (box) place(box)
      })
      .catch(() => {})
  }

  window.discoverMentions = (el, url) => {
    render(url || location.origin + location.pathname, box => {
      // placement checks run here, after the fetch - the host may have
      // re-rendered or navigated away while it was in flight
      if (!el.isConnected || el.querySelector('.discover-mentions')) return
      el.appendChild(box)
    })
  }

  if (script.hasAttribute('data-manual')) return

  // auto flow: canonical beats location - it's the url people actually linked
  const canonical = document.querySelector('link[rel="canonical"]')
  render((canonical && canonical.href) || (location.origin + location.pathname), box => {
    // guard here, not at script start - two deferred copies of this
    // script both run before either fetch lands, so an early check
    // would pass twice and catch nothing
    if (document.querySelector('.discover-mentions')) return
    script.insertAdjacentElement('afterend', box)
  })
})()
