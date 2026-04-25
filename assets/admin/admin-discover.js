import { api, $, escHtml, showError, timeAgo, ICON_EXTERNAL, ICON_TRASH, ICON_CLOSE, ICON_REFRESH } from './admin-utils.js'

let dcEntries = []
let pendingEditId = null

export async function renderDcBlocked () {
  const blocked = await api('GET', '/api/discover/admin/blocked')
  const list = Array.isArray(blocked) ? blocked : []
  $('dc-block-textarea').value = list.join('\n')
}

$('btn-dc-block-save').addEventListener('click', async () => {
  const entries = $('dc-block-textarea').value.split('\n').map(l => {
    const t = l.trim()
    try { return new URL(t).hostname.replace(/^www\./, '') } catch { return t }
  }).filter(Boolean)
  await api('PUT', '/api/discover/admin/blocked', { entries })
  await renderDcBlocked()
})

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
      <span class="post-row-meta" title="imports">${e.imports || 0} ↓</span>
      <div class="post-row-actions">
        <a href="/discover/${escHtml(e.id)}" target="_blank" rel="noopener" class="icon-btn" aria-label="View">${ICON_EXTERNAL}</a>
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
        <div class="field" style="flex:1"><input type="text" class="dc-edit-author-name" value="${escHtml(e.author?.name || '')}" placeholder="author name"></div>
        <div class="field" style="flex:1"><input type="url" class="dc-edit-author-url" value="${escHtml(e.author?.url || '')}" placeholder="author url"></div>
      </div>
      <div class="field"><input type="text" class="dc-edit-description" value="${escHtml(e.description || '')}" placeholder="description"></div>
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
  dcEntries = data.feeds || []
  const el = $('dc-entries-list')
  $('dc-entries-count').textContent = dcEntries.length ? `(${dcEntries.length})` : ''
  if (!dcEntries.length) { el.innerHTML = '<p class="muted">no entries yet.</p>'; return }
  const sorted = [...dcEntries].sort((a, b) => a.title.localeCompare(b.title))
  el.innerHTML = sorted.map(e => pendingEditId === e.id ? dcEntryEdit(e) : dcEntryRow(e)).join('')
  bindDcEntryRows(el)
  const playlistOptions = [...dcEntries].sort((a, b) => a.title.localeCompare(b.title)).map(e => `<option value="${escHtml(e.id)}">${escHtml(e.title)}</option>`).join('')
  const playlistPicker = $('dc-source-playlist')
  if (playlistPicker) playlistPicker.innerHTML = '<option value="">+ playlist</option>' + playlistOptions
  const batchPicker = $('dc-batch-playlist')
  if (batchPicker) {
    const current = batchPicker.value
    batchPicker.innerHTML = '<option value="">no playlist</option>' + playlistOptions
    if (current) batchPicker.value = current
  }
  if (pendingEditId) {
    const target = el.querySelector(`[data-dc-id="${pendingEditId}"]`)
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    pendingEditId = null
  }
  await renderDcSources()
}

const sourceStatusDot = (s) => {
  if (!s.lastFetched) return '<span class="status-dot status-null" title="never fetched"></span>'
  if (!s.statusCode) return `<span class="status-dot status-error" title="${escHtml(s.error || 'network error')} · ${timeAgo(s.lastFetched)}"></span>`
  const cls = s.statusCode === 200 ? 'status-ok' : s.statusCode < 500 ? 'status-warn' : 'status-error'
  const ago = timeAgo(s.lastFetched)
  const tip = s.statusCode === 200 ? (s.hasPosts ? `200 OK · ${ago}` : `200 — no posts · ${ago}`) : `${s.statusCode} · ${ago}`
  return `<span class="status-dot ${cls}" title="${tip}"></span>`
}

async function renderDcSources () {
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
  dcEntries.forEach(e => (e.sources || []).forEach(url => {
    if (!urlToMixes[url]) urlToMixes[url] = []
    urlToMixes[url].push(e)
  }))
  const rank = s => s.statusCode === 200 && s.hasPosts ? 2 : s.statusCode === 200 ? 1 : 0
  const sorted = [...sources].sort((a, b) => rank(a) - rank(b) || a.url.localeCompare(b.url))
  const playlistOptions = [...dcEntries].sort((a, b) => a.title.localeCompare(b.title)).map(e => `<option value="${escHtml(e.id)}">${escHtml(e.title)}</option>`).join('')

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
      const feed = dcEntries.find(e => e.id === id)
      if (!feed) return
      const newSources = (feed.sources || []).filter(s => s !== url)
      const res = await api('PATCH', `/api/discover/admin/${id}`, { sources: newSources })
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
      [...dcEntries].sort((a, b) => a.title.localeCompare(b.title)).map(e => `<option value="${escHtml(e.id)}">${escHtml(e.title)}</option>`).join('')
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
        (status === 'null' && cls.includes('status-null'))
      row.style.display = matchQ && matchP && matchS ? '' : 'none'
    })
  }

  const searchEl = $('dc-sources-search')
  if (searchEl) searchEl.oninput = applySourceFilters
  if (playlistFilterEl) playlistFilterEl.onchange = applySourceFilters
  const statusFilterEl = $('dc-sources-filter-status')
  if (statusFilterEl) statusFilterEl.onchange = applySourceFilters
}

function bindDcEntryRows (el) {
  el.querySelectorAll('[data-action]').forEach(btn => {
    const wrap = btn.closest('[data-dc-id]')
    const id = wrap.dataset.dcId
    const entry = dcEntries.find(e => e.id === id)

    if (wrap.dataset.editing) {
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
          featured: wrap.querySelector('.dc-edit-featured').checked,
          author: {
            name: wrap.querySelector('.dc-edit-author-name').value.trim(),
            url: wrap.querySelector('.dc-edit-author-url').value.trim()
          }
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

export async function renderDcPending () {
  const pending = await api('GET', '/api/discover/admin/pending')
  const list = Array.isArray(pending) ? pending : []
  const el = $('dc-pending-list')
  const countEl = $('dc-pending-count')
  const badge = $('nav-pending-badge')
  if (countEl) countEl.textContent = list.length ? `(${list.length})` : ''
  if (badge) {
    badge.textContent = list.length || ''
    badge.classList.toggle('hidden', !list.length)
    badge.style.cursor = list.length ? 'pointer' : ''
    badge.onclick = list.length ? () => $('dc-pending-list').scrollIntoView({ behavior: 'smooth', block: 'start' }) : null
  }
  if (!el) return
  if (!list.length) { el.innerHTML = '<p class="muted" style="font-size:var(--text-sm)">no pending submissions.</p>'; return }
  const playlistOptions = [...dcEntries].sort((a, b) => a.title.localeCompare(b.title))
    .map(e => `<option value="${escHtml(e.id)}">${escHtml(e.title)}</option>`).join('')

  el.innerHTML = list.map(p => `
    <div class="dc-pending-row" data-pending-url="${escHtml(p.url)}">
      <div class="dc-pending-url">${escHtml(p.url)}</div>
      <div class="dc-pending-meta">submitted ${timeAgo(p.submittedAt)}</div>
      <div class="dc-pending-actions">
        <select class="dc-pending-playlist">
          <option value="">no playlist</option>
          ${playlistOptions}
        </select>
        <button class="btn btn-sm btn-primary dc-pending-approve">approve</button>
        <button class="btn btn-sm dc-pending-reject">reject</button>
        <button class="btn btn-sm btn-danger dc-pending-block">block</button>
        <a href="${escHtml(p.url)}" target="_blank" rel="noopener" class="icon-btn" aria-label="Open feed">${ICON_EXTERNAL}</a>
      </div>
    </div>`).join('')

  el.querySelectorAll('.dc-pending-approve').forEach(btn => {
    const row = btn.closest('[data-pending-url]')
    btn.addEventListener('click', async () => {
      const url = row.dataset.pendingUrl
      const playlistId = row.querySelector('.dc-pending-playlist').value
      btn.disabled = true
      const res = await api('POST', '/api/discover/admin/approve', { url, playlistId: playlistId || null })
      if (res.error) { alert(res.error); btn.disabled = false; return }
      await Promise.all([renderDcEntries(), renderDcPending()])
    })
  })

  el.querySelectorAll('.dc-pending-reject').forEach(btn => {
    const row = btn.closest('[data-pending-url]')
    btn.addEventListener('click', async () => {
      const url = row.dataset.pendingUrl
      const res = await api('DELETE', '/api/discover/admin/pending', { url })
      if (res.error) { alert(res.error); return }
      await renderDcPending()
    })
  })

  el.querySelectorAll('.dc-pending-block').forEach(btn => {
    const row = btn.closest('[data-pending-url]')
    btn.addEventListener('click', async () => {
      const url = row.dataset.pendingUrl
      let domain
      try { domain = new URL(url).hostname.replace(/^www\./, '') } catch { domain = url }
      const [rejectRes, blocked] = await Promise.all([
        api('DELETE', '/api/discover/admin/pending', { url }),
        api('GET', '/api/discover/admin/blocked')
      ])
      if (rejectRes.error) { alert(rejectRes.error); return }
      const list = Array.isArray(blocked) ? blocked : []
      if (!list.includes(domain)) {
        await api('PUT', '/api/discover/admin/blocked', { entries: [...list, domain] })
      }
      await renderDcPending()
    })
  })
}

const BATCH_STATUS_LABEL = {
  valid: 'valid',
  duplicate: 'already in discover',
  pending: 'already pending',
  blocked: 'blocked',
  'click-through': 'click-through',
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
    const cls = r.status === 'valid' ? 'valid' : r.status === 'duplicate' || r.status === 'pending' ? 'pending-q' : 'error'
    const label = BATCH_STATUS_LABEL[r.status] || r.status
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
      await renderDcPending()
    })
  })

  el.querySelectorAll('.dc-batch-add-direct').forEach(btn => {
    btn.addEventListener('click', async () => {
      const playlistId = $('dc-batch-playlist')?.value
      btn.disabled = true
      const res = await api('POST', '/api/discover/admin/source', { url: btn.dataset.url })
      if (res.error) { alert(res.error); btn.disabled = false; return }
      if (playlistId) {
        await api('POST', `/api/discover/admin/${playlistId}/sources`, { url: btn.dataset.url })
      }
      btn.textContent = '✓ added'
      await renderDcEntries()
    })
  })
})

$('btn-dc-check').addEventListener('click', async () => {
  const btn = $('btn-dc-check')
  const status = $('dc-check-status')
  btn.disabled = true
  const frames = ['running.', 'running..', 'running...']
  let f = 0
  btn.textContent = frames[0]
  const ticker = setInterval(() => { btn.textContent = frames[++f % frames.length] }, 400)
  const res = await api('POST', '/api/discover/admin/check', {})
  clearInterval(ticker)
  btn.textContent = 'refresh feeds'
  btn.disabled = false
  if (res.ok) {
    const t = new Date().toLocaleTimeString()
    status.textContent = `last run: ${t} — ${res.processed} refreshed`
    await renderDcEntries()
  } else {
    status.textContent = 'last run: failed'
  }
})

$('btn-dc-add').addEventListener('click', async () => {
  const title = $('dc-title').value.trim()
  if (!title) { showError('dc-error', 'title required'); return }
  $('dc-error').classList.add('hidden')
  const body = {
    title,
    description: $('dc-description').value.trim(),
    tags: $('dc-tags').value.split(',').map(t => t.trim()).filter(Boolean),
    featured: $('dc-featured').checked,
    sources: [],
    author: { name: $('dc-author-name').value.trim(), url: $('dc-author-url').value.trim() }
  }
  const res = await api('POST', '/api/discover/admin/add', body)
  if (res.error) { showError('dc-error', res.error); return }
  $('dc-title').value = ''
  $('dc-description').value = ''
  $('dc-tags').value = ''
  $('dc-author-name').value = ''
  $('dc-author-url').value = ''
  $('dc-featured').checked = false
  await renderDcEntries()
})

$('btn-dc-add-source').addEventListener('click', async () => {
  const url = $('dc-source-url').value.trim()
  if (!url) return
  if (!URL.canParse(url)) { alert('invalid url'); return }
  const playlistId = $('dc-source-playlist')?.value
  const res = await api('POST', '/api/discover/admin/source', { url })
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
