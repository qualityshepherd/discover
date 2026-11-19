import { api, $, escHtml } from './admin-utils.js'
import { renderDcEntries } from './admin-playlists.js'

const BATCH_STATUS_LABEL = {
  valid: 'valid',
  duplicate: 'already in discover',
  pending: 'already pending',
  blocked: 'blocked',
  truncated: 'excerpts only',
  'no-content': 'no content',
  'fetch-error': 'fetch error',
  'invalid-url': 'invalid url',
  'not-rss': 'not rss'
}

$('btn-dc-batch-validate').addEventListener('click', async () => {
  const btn = $('btn-dc-batch-validate')
  const urls = $('dc-batch-urls').value.split('\n').map(l => l.trim()).filter(Boolean)
  if (!urls.length) return
  btn.disabled = true
  btn.textContent = 'validating…'
  const results = await api('POST', '/api/discover/admin/validate', { urls: urls.slice(0, 20) })
  btn.disabled = false
  btn.textContent = 'validate'
  const el = $('dc-batch-results')
  if (!Array.isArray(results)) { el.innerHTML = '<p class="muted">error</p>'; return }
  el.innerHTML = results.map(r => {
    const cls = r.status === 'valid' && !r.duplicateOf ? 'valid' : r.status === 'valid' || r.status === 'duplicate' || r.status === 'pending' ? 'pending-q' : 'error'
    const label = r.duplicateOf ? `same blog as ${r.duplicateOf}` : BATCH_STATUS_LABEL[r.status] || r.status
    const addBtn = r.status === 'valid'
      ? `<button class="btn btn-sm dc-batch-add-pending" data-url="${escHtml(r.url)}" data-title="${escHtml(r.title || '')}">+ pending</button>`
      : ''
    const addDirectBtn = r.status === 'valid'
      ? `<button class="btn btn-sm btn-primary dc-batch-add-direct" data-url="${escHtml(r.url)}" data-title="${escHtml(r.title || '')}">add</button>`
      : ''
    return `<div class="dc-batch-result">
      <div class="dc-batch-url">${escHtml(r.url)}</div>
      <span class="dc-batch-status ${cls}">${escHtml(label)}</span>
      ${addBtn}${addDirectBtn}
    </div>`
  }).join('')

  el.querySelectorAll('.dc-batch-add-pending').forEach(btn => {
    btn.addEventListener('click', async () => {
      const res = await api('POST', '/api/discover/submit', { url: btn.dataset.url })
      if (res.error && res.error !== 'already submitted') { alert(res.error); return }
      btn.textContent = '✓ queued'
      btn.disabled = true
    })
  })

  el.querySelectorAll('.dc-batch-add-direct').forEach(btn => {
    btn.addEventListener('click', async () => {
      const playlistId = $('dc-batch-playlist')?.value
      btn.disabled = true
      // validate already showed any same-blog warning, so this is on purpose
      const res = await api('POST', '/api/discover/admin/source', { url: btn.dataset.url, force: true })
      if (res.error) { alert(res.error); btn.disabled = false; return }
      if (playlistId) {
        await api('POST', `/api/discover/admin/${playlistId}/sources`, { url: btn.dataset.url })
      }
      btn.textContent = '✓ added'
      await renderDcEntries()
    })
  })
})
