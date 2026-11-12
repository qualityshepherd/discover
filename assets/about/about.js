const themeBtn = document.querySelector('#btn-theme')
const update = () => { themeBtn.textContent = document.documentElement.dataset.theme === 'light' ? '☽' : '☀' }
themeBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'
  document.documentElement.dataset.theme = next
  localStorage.setItem('discover_theme', next)
  update()
})
update()

const suggestUrl = document.getElementById('suggest-url')
const suggestBtn = document.getElementById('btn-suggest')
const suggestStatus = document.getElementById('suggest-status')
const suggest = async () => {
  const url = suggestUrl.value.trim()
  if (!url) return
  suggestBtn.disabled = true
  suggestBtn.textContent = '…'
  try {
    const res = await fetch('/api/discover/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    })
    const data = await res.json()
    if (!res.ok) {
      suggestStatus.textContent = data.error || 'something went wrong'
      suggestStatus.className = 'feed-add-status error'
    } else {
      suggestUrl.value = ''
      suggestStatus.textContent = 'thanks! we\'ll take a look.'
      suggestStatus.className = 'feed-add-status ok'
      setTimeout(() => { suggestStatus.textContent = ''; suggestStatus.className = 'feed-add-status' }, 4000)
    }
  } catch {
    suggestStatus.textContent = 'something went wrong'
    suggestStatus.className = 'feed-add-status error'
  } finally {
    suggestBtn.disabled = false
    suggestBtn.textContent = 'suggest'
  }
}
suggestBtn.addEventListener('click', suggest)
suggestUrl.addEventListener('keydown', e => { if (e.key === 'Enter') suggest() })
