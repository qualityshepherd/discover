import { $, api, escHtml, timeAgo } from './admin-utils.js'

const btn = document.getElementById('btn-curate-scan')
const scanStatus = document.getElementById('curate-scan-status')
if (btn) {
  btn.addEventListener('click', async () => {
    btn.disabled = true
    btn.textContent = 'scanning…'
    if (scanStatus) scanStatus.textContent = ''
    const res = await api('POST', '/api/discover/admin/build-curate-candidates')
    btn.disabled = false
    btn.textContent = 'scan all sources'
    if (scanStatus) scanStatus.textContent = res.error ? `error: ${res.error}` : `scanned ${res.sources} sources`
    if (!res.error) await renderCurate()
  })
}

export async function updateCurateBadge () {
  const data = await api('GET', '/api/discover/admin/curate')
  const count = (data?.pending?.length || 0) + (data?.candidates?.length || 0)
  const badge = $('nav-curate-badge')
  if (!badge) return
  badge.textContent = count || ''
  badge.classList.toggle('hidden', !count)
}

export async function renderCurate () {
  const [data, feedsData] = await Promise.all([
    api('GET', '/api/discover/admin/curate'),
    api('GET', '/api/discover/admin/feeds')
  ])
  const { pending = [], candidates = [], trending = [] } = data || {}
  const playlists = (feedsData?.feeds || []).sort((a, b) => a.title.localeCompare(b.title))

  const count = pending.length + candidates.length
  const badge = $('nav-curate-badge')
  if (badge) {
    badge.textContent = count || ''
    badge.classList.toggle('hidden', !count)
  }

  renderPending(pending, playlists)
  renderCandidates(candidates)
  renderTrending(trending)
  await renderBlocked()
}

function renderPending (list, playlists) {
  const el = $('curate-pending-list')
  const countEl = $('curate-pending-count')
  if (countEl) countEl.textContent = list.length ? `(${list.length})` : ''
  if (!el) return
  if (!list.length) { el.innerHTML = '<p class="muted" style="font-size:var(--text-sm)">no pending submissions.</p>'; return }

  const playlistOptions = playlists.map(e => `<option value="${escHtml(e.id)}">${escHtml(e.title)}</option>`).join('')

  el.innerHTML = list.map(p => `
    <div class="dc-pending-row" data-pending-url="${escHtml(p.url)}">
      <div class="dc-pending-url"><a href="${escHtml(p.url)}" target="_blank" rel="noopener">${escHtml(p.url)}</a></div>
      <div class="dc-pending-meta">submitted ${timeAgo(p.submittedAt)}</div>
      <div class="dc-pending-actions">
        <select class="dc-pending-playlist">
          <option value="">no playlist</option>
          ${playlistOptions}
        </select>
        <button class="btn btn-sm btn-primary dc-pending-approve">approve</button>
        <button class="btn btn-sm dc-pending-reject">reject</button>
        <button class="btn btn-sm btn-danger dc-pending-block">block</button>
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
      await renderCurate()
    })
  })

  el.querySelectorAll('.dc-pending-reject').forEach(btn => {
    const row = btn.closest('[data-pending-url]')
    btn.addEventListener('click', async () => {
      const url = row.dataset.pendingUrl
      const res = await api('DELETE', '/api/discover/admin/pending', { url })
      if (res.error) { alert(res.error); return }
      await renderCurate()
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
      if (!list.includes(domain)) await api('PUT', '/api/discover/admin/blocked', { entries: [...list, domain] })
      await renderCurate()
    })
  })
}

function renderCandidates (list) {
  const el = $('curate-candidates-list')
  const countEl = $('curate-candidates-count')
  if (countEl) countEl.textContent = list.length ? `(${list.length})` : ''
  if (!el) return
  if (!list.length) { el.innerHTML = '<p class="muted" style="font-size:var(--text-sm)">no candidates yet — check back after the next cron run.</p>'; return }

  el.innerHTML = list.map(c => `
    <div class="dc-pending-row" data-domain="${escHtml(c.domain)}">
      <div class="dc-pending-url">
        <a href="https://${escHtml(c.domain)}" target="_blank" rel="noopener">${escHtml(c.domain)}</a>
        <span class="dc-badge">${c.score} source${c.score !== 1 ? 's' : ''}</span>
      </div>
      <div class="dc-pending-meta"><a href="${escHtml(c.feedUrl)}" target="_blank" rel="noopener">${escHtml(c.feedUrl)}</a></div>
      <div class="dc-pending-actions">
        <button class="btn btn-sm btn-primary curate-approve">→ suggested</button>
        <button class="btn btn-sm btn-danger curate-dismiss">dismiss</button>
        <button class="btn btn-sm btn-danger curate-block">block</button>
      </div>
    </div>`).join('')

  el.querySelectorAll('.curate-approve').forEach(btn => {
    const row = btn.closest('[data-domain]')
    btn.addEventListener('click', async () => {
      const domain = row.dataset.domain
      const feedUrl = row.querySelector('.dc-pending-meta').textContent
      btn.disabled = true
      const res = await api('POST', '/api/discover/admin/curate/approve', { domain, feedUrl })
      if (res.error) { alert(res.error); btn.disabled = false; return }
      await renderCurate()
    })
  })

  el.querySelectorAll('.curate-dismiss').forEach(btn => {
    const row = btn.closest('[data-domain]')
    btn.addEventListener('click', async () => {
      const domain = row.dataset.domain
      const res = await api('DELETE', '/api/discover/admin/curate/candidate', { domain })
      if (res.error) { alert(res.error); return }
      await renderCurate()
    })
  })

  el.querySelectorAll('.curate-block').forEach(btn => {
    const row = btn.closest('[data-domain]')
    btn.addEventListener('click', async () => {
      const domain = row.dataset.domain
      const [, blocked] = await Promise.all([
        api('DELETE', '/api/discover/admin/curate/candidate', { domain }),
        api('GET', '/api/discover/admin/blocked')
      ])
      const list = Array.isArray(blocked) ? blocked : []
      if (!list.includes(domain)) await api('PUT', '/api/discover/admin/blocked', { entries: [...list, domain] })
      await renderCurate()
    })
  })
}

function renderTrending (list) {
  const el = $('curate-trending-list')
  const countEl = $('curate-trending-count')
  if (countEl) countEl.textContent = list.length ? `(${list.length})` : ''
  if (!el) return
  if (!list.length) { el.innerHTML = '<p class="muted" style="font-size:var(--text-sm)">no trending domains yet.</p>'; return }

  el.innerHTML = list.map(t => `
    <div class="dc-pending-row" data-domain="${escHtml(t.domain)}">
      <div class="dc-pending-url">
        <a href="https://${escHtml(t.domain)}" target="_blank" rel="noopener">${escHtml(t.domain)}</a>
        <span class="dc-badge">${t.score} source${t.score !== 1 ? 's' : ''}</span>
      </div>
      <div class="dc-pending-actions">
        <button class="btn btn-sm btn-danger curate-dismiss-trending">dismiss</button>
        <button class="btn btn-sm btn-danger curate-block-trending">block</button>
      </div>
    </div>`).join('')

  el.querySelectorAll('.curate-dismiss-trending').forEach(btn => {
    const row = btn.closest('[data-domain]')
    btn.addEventListener('click', async () => {
      const domain = row.dataset.domain
      const res = await api('DELETE', '/api/discover/admin/curate/trending', { domain })
      if (res.error) { alert(res.error); return }
      await renderCurate()
    })
  })

  el.querySelectorAll('.curate-block-trending').forEach(btn => {
    const row = btn.closest('[data-domain]')
    btn.addEventListener('click', async () => {
      const domain = row.dataset.domain
      const [, blocked] = await Promise.all([
        api('DELETE', '/api/discover/admin/curate/trending', { domain }),
        api('GET', '/api/discover/admin/blocked')
      ])
      const list = Array.isArray(blocked) ? blocked : []
      if (!list.includes(domain)) await api('PUT', '/api/discover/admin/blocked', { entries: [...list, domain] })
      await renderCurate()
    })
  })
}

async function renderBlocked () {
  const blocked = await api('GET', '/api/discover/admin/blocked')
  const list = Array.isArray(blocked) ? blocked : []
  const el = $('dc-block-textarea')
  if (el) el.value = list.join('\n')
}

document.getElementById('btn-dc-block-save')?.addEventListener('click', async () => {
  const entries = ($('dc-block-textarea').value || '').split('\n').map(l => {
    const t = l.trim()
    try { return new URL(t).hostname.replace(/^www\./, '') } catch { return t }
  }).filter(Boolean)
  await api('PUT', '/api/discover/admin/blocked', { entries })
  await renderBlocked()
})
