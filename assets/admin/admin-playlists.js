import { api, $, escHtml, showError, ICON_EXTERNAL, ICON_TRASH, ICON_CLOSE, ICON_REFRESH } from './admin-utils.js'
import { renderDcSources } from './admin-sources.js'

let entries = []
export const playlists = () => entries

const dcFreqBadge = (f) => {
  if (!f.updateFrequency || f.updateFrequency === 'unknown') return ''
  return `<span class="dc-badge">${f.updateFrequency}</span>`
}

const dcEntryRow = (e) => {
  const sourceCount = (e.sources || []).length
  return `
  <div class="dc-playlist-wrap" data-dc-id="${escHtml(e.id)}">
    <div class="post-row dc-entry-row">
      <button class="dc-playlist-toggle post-row-title truncate" data-action="edit">${escHtml(e.title)}</button>
      ${dcFreqBadge(e)}
      <span class="dc-badge${sourceCount === 0 ? ' dc-badge-danger' : ''}">${sourceCount} feeds</span>
      <div class="post-row-actions">
        <a href="/discover/${escHtml(e.slug || e.id)}" target="_blank" rel="noopener" class="icon-btn" aria-label="View">${ICON_EXTERNAL}</a>
        <button class="icon-btn" data-action="refresh" aria-label="Refresh playlist">${ICON_REFRESH}</button>
        <button class="icon-btn${e.featured ? ' active' : ''}" data-action="feature" aria-label="${e.featured ? 'unfeature' : 'feature'}">★</button>
        <button class="icon-btn danger" data-action="delete" aria-label="Delete">${ICON_TRASH}</button>
      </div>
    </div>
  </div>`
}

const dcEntryEdit = (e) => {
  const sourcesHtml = (e.sources || []).length
    ? (e.sources || []).map(url => `
        <div class="dc-playlist-source-row">
          <span class="truncate dc-source-url">${escHtml(url)}</span>
          <button class="icon-btn danger dc-remove-source" data-url="${escHtml(url)}" aria-label="Remove">${ICON_CLOSE}</button>
        </div>`).join('')
    : '<p class="muted" style="font-size:var(--text-sm);padding:var(--s2) 0">no sources.</p>'
  return `
  <div class="dc-playlist-wrap" data-dc-id="${escHtml(e.id)}" data-editing="true">
    <div class="dc-entry-edit">
      <div class="row field">
        <div class="field" style="flex:2"><input type="text" class="dc-edit-title" value="${escHtml(e.title)}" placeholder="title"></div>
        <div class="field" style="flex:2"><input type="text" class="dc-edit-tags" value="${escHtml((e.tags || []).join(', '))}" placeholder="tags, comma separated"></div>
      </div>
      <div class="row field">
        <div class="field" style="flex:2"><input type="text" class="dc-edit-description" value="${escHtml(e.description || '')}" placeholder="description"></div>
        <div class="field" style="flex:1"><input type="text" class="dc-edit-slug" value="${escHtml(e.slug || '')}" placeholder="slug (e.g. digital-archaeology)"></div>
      </div>
      <div class="dc-playlist-sources">${sourcesHtml}</div>
      <div class="flex gap-3 items-center" style="margin-top:var(--s3)">
        <label class="flex items-center gap-2" style="font-size:var(--text-sm);cursor:pointer">
          <input type="checkbox" class="dc-edit-featured"${e.featured ? ' checked' : ''}> featured
        </label>
        <div style="margin-left:auto;display:flex;gap:var(--s2)">
          <button class="btn btn-sm" data-action="cancel">Cancel</button>
          <button class="btn btn-sm btn-primary" data-action="save">Save</button>
        </div>
      </div>
    </div>
  </div>`
}

export async function renderDcEntries () {
  const data = await api('GET', '/api/discover/admin/feeds')
  entries = data.feeds || []
  const el = $('dc-entries-list')
  $('dc-entries-count').textContent = entries.length ? `(${entries.length})` : ''
  if (!entries.length) { el.innerHTML = '<p class="muted">no entries yet.</p>'; return }
  const sorted = [...entries].sort((a, b) => a.title.localeCompare(b.title))
  el.innerHTML = sorted.map(dcEntryRow).join('')
  bindDcEntryRows(el)
  const playlistOptions = [...entries].sort((a, b) => a.title.localeCompare(b.title)).map(e => `<option value="${escHtml(e.id)}">${escHtml(e.title)}</option>`).join('')
  const playlistPicker = $('dc-source-playlist')
  if (playlistPicker) playlistPicker.innerHTML = '<option value="">+ playlist</option>' + playlistOptions
  const batchPicker = $('dc-batch-playlist')
  if (batchPicker) {
    const current = batchPicker.value
    batchPicker.innerHTML = '<option value="">no playlist</option>' + playlistOptions
    if (current) batchPicker.value = current
  }
  await renderDcSources()
}

function bindDcEntryRows (el) {
  el.querySelectorAll('[data-action]').forEach(btn => {
    const wrap = btn.closest('[data-dc-id]')
    const id = wrap.dataset.dcId
    const entry = entries.find(e => e.id === id)

    // once per row, not once per button
    if (wrap.dataset.editing && !wrap.dataset.escBound) {
      wrap.dataset.escBound = '1'
      const cancel = wrap.querySelector('[data-action="cancel"]')
      wrap.querySelector('.dc-edit-title')?.focus()
      wrap.addEventListener('keydown', e => { if (e.key === 'Escape') cancel?.click() })
    }

    btn.addEventListener('click', async () => {
      const action = btn.dataset.action
      const rebind = () => {
        const newWrap = $('dc-entries-list').querySelector(`[data-dc-id="${id}"]`)
        if (newWrap) bindDcEntryRows(newWrap)
      }
      if (action === 'edit') {
        $('dc-entries-list').querySelector('[data-editing]')?.querySelector('[data-action="cancel"]')?.click()
        wrap.outerHTML = dcEntryEdit(entry); rebind()
      }
      if (action === 'cancel') { wrap.outerHTML = dcEntryRow(entry); rebind() }
      if (action === 'feature') {
        const res = await api('PATCH', `/api/discover/admin/${id}`, { featured: !entry.featured })
        if (res.error) { alert(res.error); return }
        entry.featured = !entry.featured
        wrap.outerHTML = dcEntryRow(entry)
        rebind()
      }
      if (action === 'save') {
        const body = {
          title: wrap.querySelector('.dc-edit-title').value.trim(),
          description: wrap.querySelector('.dc-edit-description').value.trim(),
          tags: wrap.querySelector('.dc-edit-tags').value.split(',').map(t => t.trim()).filter(Boolean),
          slug: wrap.querySelector('.dc-edit-slug').value.trim(),
          featured: wrap.querySelector('.dc-edit-featured').checked
        }
        const res = await api('PATCH', `/api/discover/admin/${id}`, body)
        if (res.error) { alert(res.error); return }
        await renderDcEntries()
      }
      if (action === 'refresh') {
        btn.classList.add('spinning')
        btn.disabled = true
        const res = await api('POST', `/api/discover/admin/${id}/refresh`)
        btn.classList.remove('spinning')
        btn.disabled = false
        if (res.error) { alert(res.error); return }
        await renderDcEntries()
      }
      if (action === 'delete') {
        if (!confirm(`Delete "${entry.title}"?`)) return
        const res = await api('DELETE', `/api/discover/admin/${id}`)
        if (res.error) { alert(res.error); return }
        await renderDcEntries()
      }
    })
  })

  el.querySelectorAll('.dc-remove-source').forEach(btn => {
    const wrap = btn.closest('[data-dc-id]')
    const id = wrap.dataset.dcId
    btn.addEventListener('click', async () => {
      const res = await api('DELETE', `/api/discover/admin/${id}/sources`, { url: btn.dataset.url })
      if (res.error) { alert(res.error); return }
      await renderDcEntries()
    })
  })
}

$('btn-dc-add').addEventListener('click', async () => {
  const title = $('dc-title').value.trim()
  if (!title) { showError('dc-error', 'title required'); return }
  $('dc-error').classList.add('hidden')
  const body = {
    title,
    description: $('dc-description').value.trim(),
    tags: $('dc-tags').value.split(',').map(t => t.trim()).filter(Boolean),
    featured: $('dc-featured').checked,
    sources: []
  }
  const res = await api('POST', '/api/discover/admin/add', body)
  if (res.error) { showError('dc-error', res.error); return }
  $('dc-title').value = ''
  $('dc-description').value = ''
  $('dc-tags').value = ''
  $('dc-featured').checked = false
  await renderDcEntries()
})
