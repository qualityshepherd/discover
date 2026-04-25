import { deriveKeypair, signChallenge, scorePassphrase } from '../../../../../../lib/keys.js'
import { $, api, getToken, setToken, showError } from './admin-utils.js'
import { renderDcEntries, renderDcBlocked, renderDcPending } from './admin-discover.js'
import { renderAnalytics } from './admin-analytics.js'

document.title = `${location.hostname} admin`

// ── routing ───────────────────────────────────────────────────────────────────
const routes = {
  '#discover': showDiscover,
  '#analytics': showAnalytics,
  '#settings': showSettings
}

const route = () => {
  const handler = routes[location.hash]
  if (handler) return handler()
  getToken() ? showDiscover() : showLogin()
}

window.addEventListener('hashchange', route)

// ── views ─────────────────────────────────────────────────────────────────────
const VIEWS = ['view-login', 'view-discover', 'view-analytics', 'view-settings']
const NAV_IDS = ['nav-home', 'nav-discover', 'nav-analytics', 'nav-settings']

const showView = (id) => { VIEWS.forEach(v => $(v).classList.add('hidden')); $(id).classList.remove('hidden') }
const showNav = () => NAV_IDS.forEach(id => $(id).classList.remove('hidden'))
const hideNav = () => [...NAV_IDS, 'nav-user'].forEach(id => $(id).classList.add('hidden'))

async function showLogin () {
  showView('view-login')
  hideNav()
  const { configured } = await api('GET', '/api/challenge')
  $('login-unconfigured').classList.toggle('hidden', !!configured)
  $('login-existing').classList.toggle('hidden', !configured)
}

async function showDiscover () {
  if (!getToken()) return showLogin()
  showView('view-discover'); showNav()
  await Promise.all([renderDcEntries(), renderDcBlocked(), renderDcPending(), checkCronHealth()])
}

async function checkCronHealth () {
  const status = await api('GET', '/api/discover/admin/status')
  const el = $('dc-check-status')
  if (!status?.lastCronOk) { el.textContent = 'cron: never run'; return }
  const age = Date.now() - new Date(status.lastCronOk).getTime()
  if (age > 25 * 60 * 60 * 1000) {
    el.textContent = `⚠ cron last ok ${Math.round(age / 3600000)}h ago — may be stale`
  }
}

async function showAnalytics () {
  if (!getToken()) return showLogin()
  showView('view-analytics'); showNav()
  await renderAnalytics()
}

async function showSettings () {
  if (!getToken()) return showLogin()
  showView('view-settings'); showNav()
}

// ── auth ──────────────────────────────────────────────────────────────────────
const login = async (passphrase) => {
  const { privateKey, pubkey } = await deriveKeypair(passphrase, location.hostname)
  const { challenge } = await api('GET', '/api/challenge')
  const sig = await signChallenge(challenge, privateKey)
  // raw fetch — api() treats any 401 as "session expired" but here it just means wrong passphrase
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pubkey, challenge, sig })
  }).then(r => r.json())
  if (res.error) throw new Error('invalid passphrase')
  setToken(res.token)
  localStorage.setItem('discover_pubkey', pubkey)
}

$('setup-passphrase').addEventListener('input', () => {
  const val = $('setup-passphrase').value
  const el = $('strength-display')
  if (!val) { el.classList.add('hidden'); return }
  const { score, flavor } = scorePassphrase(val)
  el.className = `passphrase-strength strength-${score}`
  el.textContent = flavor
})

$('btn-derive').addEventListener('click', async () => {
  const passphrase = $('setup-passphrase').value.trim()
  if (!passphrase) return
  const { score } = scorePassphrase(passphrase)
  if (score < 3) { showError('login-error', 'passphrase too weak — aim for a long phrase'); return }
  const { pubkey } = await deriveKeypair(passphrase, location.hostname)
  $('pubkey-display').value = pubkey
  $('pubkey-result').classList.remove('hidden')
  $('login-error').classList.add('hidden')
})

$('btn-login').addEventListener('click', async () => {
  const passphrase = $('login-passphrase').value.trim()
  if (!passphrase) return
  try { await login(passphrase); location.hash = '#discover' } catch (e) { showError('login-error', e.message) }
})

$('btn-logout').addEventListener('click', () => {
  setToken(null)
  location.hash = ''
  showLogin()
})

document.querySelectorAll('.eye-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = $(btn.dataset.target)
    input.type = input.type === 'password' ? 'text' : 'password'
  })
})

// ── init ──────────────────────────────────────────────────────────────────────
if (getToken()) route(); else showLogin()
