import { api, $, escHtml, timeAgo, ICON_EXTERNAL, ICON_TRASH, ICON_REFRESH } from './admin-utils.js'
import { renderDcEntries, playlists } from './admin-playlists.js'

const DEAD_MS = 18 * 30.5 * 24 * 60 * 60 * 1000
const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('en', { month: 'short', year: 'numeric' }) : null

const sourceStatusDot = (s) => {
  if (!s.lastFetched) return '<span class="status-dot status-null" title="never fetched"></span>'
  if (!s.statusCode) return `<span class="status-dot status-error" title="${escHtml(s.error || 'network error')} · ${timeAgo(s.lastFetched)}"></span>`
  if (s.statusCode === 200 && s.frequency === 'inactive') {
    const postDate = s.latestPostDate ? new Date(s.latestPostDate) : null
    const isDead = postDate && (Date.now() - postDate.getTime() > DEAD_MS)
    const dateStr = fmtDate(s.latestPostDate) || 'unknown'
    return `<span class="status-dot ${isDead ? 'status-dead' : 'status-inactive'}" title="inactive · last post ${dateStr}"></span>`
  }
  const cls = s.statusCode === 200 ? 'status-ok' : s.statusCode < 500 ? 'status-warn' : 'status-error'
  const ago = timeAgo(s.lastFetched)
  const tip = s.statusCode === 200 ? (s.hasPosts ? `200 OK · ${ago}` : `200 — no posts · ${ago}`) : `${s.statusCode} · ${ago}`
  return `<span class="status-dot ${cls}" title="${tip}"></span>`
}

export async function renderDcSources () {
  const sources = await api('GET', '/api/discover/admin/sources')
  const el = $('dc-sources-list')
  if (!el) return
  const countEl = $('dc-sources-count')
  if (countEl) {
    const failed = sources.filter(s => s.statusCode !== 200).length
    countEl.textContent = sources.length ? `(${sources.length}${failed ? ` · ${failed} failed` : ''})` : ''
  }
  if (!Array.isArray(sources) || !sources.length) { el.innerHTML = '<p class="muted">no sources yet — run refresh feeds.</p>'; return }
  const urlToMixes = {}
  playlists().forEach(e => (e.sources || []).forEach(url => {
    if (!urlToMixes[url]) urlToMixes[url] = []
    urlToMixes[url].push(e)
  }))
  const rank = s => s.statusCode === 200 && s.hasPosts ? 2 : s.statusCode === 200 ? 1 : 0
  const sorted = [...sources].sort((a, b) => rank(a) - rank(b) || a.url.localeCompare(b.url))
  const playlistOptions = [...playlists()].sort((a, b) => a.title.localeCompare(b.title)).map(e => `<option value="${escHtml(e.id)}">${escHtml(e.title)}</option>`).join('')

  el.innerHTML = sorted.map(s => {
    const playlists = urlToMixes[s.url] || []
    const badgesHtml = playlists.map(m =>
      `<span class="dc-mix-badge" data-url="${escHtml(s.url)}" data-id="${escHtml(m.id)}" data-title="${escHtml(m.title)}">${escHtml(m.title)}<button class="dc-mix-remove" aria-label="Remove from ${escHtml(m.title)}">✕</button></span>`
    ).join('')
    return `<div class="post-row dc-source-row">
      ${sourceStatusDot(s)}
      <div class="post-row-title truncate" style="flex:1;min-width:0">
        <button class="dc-source-edit truncate" data-url="${escHtml(s.url)}" title="${escHtml(s.url)}">${escHtml(s.url)}</button>
      </div>
      <div class="dc-source-mixes" style="flex-shrink:0;max-width:200px;display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end">${badgesHtml}</div>
      <select class="dc-source-add-playlist" data-url="${escHtml(s.url)}" title="Add to playlist">
        <option value="">+ playlist</option>
        ${playlistOptions}
      </select>
      <div class="post-row-actions">
        <a href="${escHtml(s.url)}" target="_blank" rel="noopener" class="icon-btn" aria-label="Open feed">${ICON_EXTERNAL}</a>
        <button class="icon-btn dc-source-refresh" data-url="${escHtml(s.url)}" aria-label="Refresh source" title="Refresh · ${s.lastFetched ? timeAgo(s.lastFetched) : 'never fetched'}">${ICON_REFRESH}</button>
        <button class="icon-btn danger dc-source-delete" data-url="${escHtml(s.url)}" aria-label="Delete source">${ICON_TRASH}</button>
      </div>
    </div>`
  }).join('')

  el.querySelectorAll('.dc-source-add-playlist').forEach(sel => {
    sel.addEventListener('change', async () => {
      const playlistId = sel.value
      if (!playlistId) return
      sel.value = ''
      const res = await api('POST', `/api/discover/admin/${playlistId}/sources`, { url: sel.dataset.url })
      if (res.error) { alert(res.error); return }
      await renderDcEntries()
    })
  })

  el.querySelectorAll('.dc-source-refresh').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.classList.add('spinning')
      btn.disabled = true
      const res = await api('POST', '/api/discover/admin/source/refresh', { url: btn.dataset.url })
      btn.classList.remove('spinning')
      btn.disabled = false
      if (res.error) { alert(res.error); return }
      await renderDcSources()
    })
  })

  el.querySelectorAll('.dc-source-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Remove ${btn.dataset.url} from all playlists?`)) return
      const res = await api('DELETE', '/api/discover/admin/source', { url: btn.dataset.url })
      if (res.error) { alert(res.error); return }
      await renderDcEntries()
    })
  })

  el.querySelectorAll('.dc-mix-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const badge = btn.closest('.dc-mix-badge')
      const { url, id, title } = badge.dataset
      if (!confirm(`Remove from "${title}"?`)) return
      // same route as the playlist editor's remove, so source cleanup happens
      const res = await api('DELETE', `/api/discover/admin/${id}/sources`, { url })
      if (res.error) { alert(res.error); return }
      await renderDcEntries()
    })
  })

  el.querySelectorAll('.dc-source-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const oldUrl = btn.dataset.url
      const input = document.createElement('input')
      input.type = 'url'
      input.value = oldUrl
      input.className = 'dc-source-url-input'
      btn.replaceWith(input)
      input.focus()
      input.select()

      let done = false
      const save = async () => {
        if (done) return
        done = true
        const newUrl = input.value.trim()
        if (!newUrl || newUrl === oldUrl) { input.replaceWith(btn); return }
        const res = await api('PATCH', '/api/discover/admin/source', { oldUrl, newUrl })
        if (res.error) { alert(res.error); input.replaceWith(btn); return }
        await renderDcEntries()
      }
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); save() }
        if (e.key === 'Escape') { done = true; input.replaceWith(btn) }
      })
      input.addEventListener('blur', save)
    })
  })

  const playlistFilterEl = $('dc-sources-filter-playlist')
  if (playlistFilterEl) {
    playlistFilterEl.innerHTML = '<option value="">all playlists</option>' +
      [...playlists()].sort((a, b) => a.title.localeCompare(b.title)).map(e => `<option value="${escHtml(e.id)}">${escHtml(e.title)}</option>`).join('')
  }

  const applySourceFilters = () => {
    const q = ($('dc-sources-search')?.value || '').toLowerCase()
    const pid = $('dc-sources-filter-playlist')?.value || ''
    const status = $('dc-sources-filter-status')?.value || ''
    el.querySelectorAll('.dc-source-row').forEach(row => {
      const url = row.querySelector('.dc-source-edit')?.dataset.url || ''
      const matchQ = !q || url.toLowerCase().includes(q)
      const matchP = !pid || (pid === '__none__' ? !(urlToMixes[url] || []).length : (urlToMixes[url] || []).some(m => m.id === pid))
      const dot = row.querySelector('.status-dot')
      const cls = dot?.className || ''
      const matchS = !status ||
        (status === 'ok' && cls.includes('status-ok')) ||
        (status === 'warn' && cls.includes('status-warn')) ||
        (status === 'error' && cls.includes('status-error')) ||
        (status === 'inactive' && cls.includes('status-inactive')) ||
        (status === 'dead' && cls.includes('status-dead')) ||
        (status === 'null' && cls.includes('status-null'))
      row.style.display = matchQ && matchP && matchS ? '' : 'none'
    })
  }

  const searchEl = $('dc-sources-search')
  if (searchEl) searchEl.oninput = applySourceFilters
  if (playlistFilterEl) playlistFilterEl.onchange = applySourceFilters
  const statusFilterEl = $('dc-sources-filter-status')
  if (statusFilterEl) statusFilterEl.onchange = applySourceFilters
  // re-renders keep whatever search was typed
  applySourceFilters()
}

$('btn-dc-add-source').addEventListener('click', async () => {
  const url = $('dc-source-url').value.trim()
  if (!url) return
  if (!URL.canParse(url)) { alert('invalid url'); return }
  const playlistId = $('dc-source-playlist')?.value
  let res = await api('POST', '/api/discover/admin/source', { url })
  if (res.duplicateOf) {
    if (!confirm(`same blog as ${res.duplicateOf}, already in discover. add anyway?`)) return
    res = await api('POST', '/api/discover/admin/source', { url, force: true })
  }
  if (res.error) { alert(res.error); return }
  if (res.existing && !playlistId) { alert('source already exists'); return }
  if (playlistId) {
    const r2 = await api('POST', `/api/discover/admin/${playlistId}/sources`, { url })
    if (r2.error) { alert(r2.error); return }
  }
  $('dc-source-url').value = ''
  if ($('dc-source-playlist')) $('dc-source-playlist').value = ''
  await renderDcEntries()
})

$('dc-source-url').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-dc-add-source').click() })
