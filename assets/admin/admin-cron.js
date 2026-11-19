import { api, $, timeAgo } from './admin-utils.js'
import { renderDcEntries } from './admin-playlists.js'

export async function loadCronStatus () {
  const status = $('dc-check-status')
  if (!status) return
  const res = await api('GET', '/api/discover/admin/status')
  const count = res.lastCronCount != null ? ` · ${res.lastCronCount} sources` : ''
  status.textContent = res.lastCronOk ? `last run: ${timeAgo(res.lastCronOk)}${count}` : 'never run'
}

const waitForCronOk = async (since) => {
  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => setTimeout(resolve, 3000))
    const s = await api('GET', '/api/discover/admin/status')
    if (s.lastCronOk && new Date(s.lastCronOk).getTime() >= since) return s
  }
  return null
}

$('btn-dc-check').addEventListener('click', async () => {
  const btn = $('btn-dc-check')
  const status = $('dc-check-status')
  const all = $('dc-check-all')?.checked
  btn.disabled = true

  if (!all) {
    const frames = ['running.', 'running..', 'running...']
    let f = 0
    btn.textContent = frames[0]
    const ticker = setInterval(() => { btn.textContent = frames[++f % frames.length] }, 400)
    const res = await api('POST', '/api/discover/admin/check', {})
    clearInterval(ticker)
    btn.textContent = 'run cron'
    btn.disabled = false
    status.textContent = res.ok ? 'last run: just now' : 'failed'
    if (res.ok) setTimeout(renderDcEntries, 5000)
    return
  }

  // all mode — fetch total then loop batches
  const sources = await api('GET', '/api/discover/admin/sources')
  const total = sources?.length ?? 0
  const spin = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let done = 0
  while (done < total) {
    let sf = 0
    const spinTicker = setInterval(() => { btn.textContent = `${done} / ${total} ${spin[sf++ % spin.length]}` }, 100)
    const triggeredAt = Date.now()
    const res = await api('POST', '/api/discover/admin/check', {})
    if (!res.ok) { clearInterval(spinTicker); status.textContent = 'failed'; break }
    const s = await waitForCronOk(triggeredAt)
    clearInterval(spinTicker)
    btn.textContent = `${done} / ${total}`
    if (!s) break
    done += s.lastCronCount ?? 0
    status.textContent = `${done} / ${total}`
    btn.textContent = `${done} / ${total}`
    if (!s.lastCronCount) break
  }

  btn.textContent = 'run cron'
  btn.disabled = false
  if ($('dc-check-all')) $('dc-check-all').checked = false
  renderDcEntries()
})
