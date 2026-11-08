// Verifies the cron's write paths only touch rows that actually changed.
// Uses node:sqlite (Node 22+) with the project's own migrations; skips on older Node.
import { readdirSync, readFileSync } from 'node:fs'
import { unit as test } from '../testpup.js'
import { savePostTags } from '../../worker/db-search.js'
import { saveMentions } from '../../worker/db-mentions.js'
import { saveFeed } from '../../worker/db-feeds.js'

let DatabaseSync = null
try { ({ DatabaseSync } = await import('node:sqlite')) } catch {}

// Minimal D1-shaped adapter over node:sqlite that counts rows changed
const makeDb = () => {
  const sqlite = new DatabaseSync(':memory:')
  for (const f of readdirSync('migrations').filter(n => n.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(`migrations/${f}`, 'utf8'))
  }
  const db = { sqlite, changes: 0 }
  const wrap = (stmt, params) => ({
    bind: (...p) => wrap(stmt, p),
    _run: () => { const r = stmt.run(...params); db.changes += Number(r.changes); return r },
    run: async function () { return { meta: { changes: this._run().changes } } },
    all: async () => ({ results: stmt.all(...params) }),
    first: async () => stmt.get(...params) ?? null
  })
  db.prepare = (sql) => wrap(sqlite.prepare(sql), [])
  db.batch = async (stmts) => {
    sqlite.exec('BEGIN')
    try { for (const s of stmts) s._run(); sqlite.exec('COMMIT') } catch (e) { sqlite.exec('ROLLBACK'); throw e }
  }
  return db
}

const rows = (db, sql, ...p) => db.sqlite.prepare(sql).all(...p)
const skip = !DatabaseSync

const posts = (spec) => spec.map(([url, tags, date]) => ({ url, tags, date }))

test('savePostTags: first write inserts, identical re-run writes nothing', async t => {
  if (skip) return
  const db = makeDb()
  const fetched = posts([['https://a.test/1', ['x', 'y'], '2026-10-01'], ['https://a.test/2', ['x'], '2026-10-02']])
  await savePostTags(db, 'https://a.test/feed', fetched)
  t.is(rows(db, 'SELECT * FROM post_tags').length, 3)

  db.changes = 0
  await savePostTags(db, 'https://a.test/feed', fetched)
  t.is(db.changes, 0)
})

test('savePostTags: removed tags are deleted, new ones added, others untouched', async t => {
  if (skip) return
  const db = makeDb()
  await savePostTags(db, 'https://a.test/feed', posts([['https://a.test/1', ['x', 'y'], '2026-10-01']]))
  db.changes = 0
  await savePostTags(db, 'https://a.test/feed', posts([['https://a.test/1', ['x', 'z'], '2026-10-01']]))
  t.is(db.changes, 2) // delete y + insert z, x untouched
  t.deepEqual(rows(db, 'SELECT tag FROM post_tags ORDER BY tag').map(r => r.tag), ['x', 'z'])
})

test('savePostTags: a post that vanishes from the feed loses its tags; other sources are untouched', async t => {
  if (skip) return
  const db = makeDb()
  await savePostTags(db, 'https://b.test/feed', posts([['https://b.test/1', ['keep'], '2026-10-01']]))
  await savePostTags(db, 'https://a.test/feed', posts([['https://a.test/1', ['x'], '2026-10-01']]))
  await savePostTags(db, 'https://a.test/feed', [])
  t.deepEqual(rows(db, 'SELECT source_url FROM post_tags').map(r => r.source_url), ['https://b.test/feed'])
})

const mention = (post, extra = {}) => ({
  fromSource: 'https://a.test/feed',
  fromPost: post,
  fromTitle: 'T',
  fromDate: '2026-10-01',
  fromContent: '<p>hi</p>',
  toUrl: 'https://bob.test/x',
  ...extra
})

test('saveMentions: identical re-run writes nothing and preserves found_at', async t => {
  if (skip) return
  const db = makeDb()
  const list = [mention('https://a.test/p1'), mention('https://a.test/p2')]
  await saveMentions(db, 'bob.test', list)
  db.sqlite.exec("UPDATE mentions SET found_at = '2020-01-01 00:00:00'")

  db.changes = 0
  await saveMentions(db, 'bob.test', list)
  t.is(db.changes, 0)
  t.deepEqual(rows(db, 'SELECT DISTINCT found_at FROM mentions').map(r => r.found_at), ['2020-01-01 00:00:00'])
})

test('saveMentions: inserts new, deletes dropped, updates edited, leaves the rest', async t => {
  if (skip) return
  const db = makeDb()
  await saveMentions(db, 'bob.test', [mention('https://a.test/p1'), mention('https://a.test/p2'), mention('https://a.test/p3')])
  db.changes = 0
  await saveMentions(db, 'bob.test', [
    mention('https://a.test/p1'), // unchanged
    mention('https://a.test/p2', { fromTitle: 'Edited' }), // updated
    mention('https://a.test/p4') // new; p3 dropped
  ])
  const byPost = Object.fromEntries(rows(db, 'SELECT from_post, from_title FROM mentions').map(r => [r.from_post, r.from_title]))
  t.deepEqual(byPost, { 'https://a.test/p1': 'T', 'https://a.test/p2': 'Edited', 'https://a.test/p4': 'T' })
})

test('saveMentions: only touches the given domain', async t => {
  if (skip) return
  const db = makeDb()
  await saveMentions(db, 'bob.test', [mention('https://a.test/p1')])
  await saveMentions(db, 'carol.test', [mention('https://a.test/p1', { toUrl: 'https://carol.test/' })])
  await saveMentions(db, 'bob.test', [])
  t.deepEqual(rows(db, 'SELECT to_domain FROM mentions').map(r => r.to_domain), ['carol.test'])
})

const feed = (extra = {}) => ({
  id: 'f1',
  title: 'Cool',
  description: 'd',
  tags: ['a'],
  sources: ['https://a.test/feed', 'https://b.test/feed'],
  previewPosts: [],
  ...extra
})

test('saveFeed: default call syncs sources and the search index', async t => {
  if (skip) return
  const db = makeDb()
  await saveFeed(db, feed())
  t.is(rows(db, 'SELECT * FROM feed_sources').length, 2)
  t.is(rows(db, "SELECT * FROM feeds_fts WHERE feed_id = 'f1'").length, 1)
})

test('saveFeed: syncChildren false updates the feed row only', async t => {
  if (skip) return
  const db = makeDb()
  await saveFeed(db, feed())
  db.changes = 0
  await saveFeed(db, feed({ previewPosts: [{ title: 'new post' }], lastUpdated: '2026-10-18T00:00:00Z' }), { syncChildren: false })
  t.is(db.changes, 1)
  t.ok(rows(db, "SELECT preview_posts FROM feeds WHERE id = 'f1'")[0].preview_posts.includes('new post'))
  t.is(rows(db, 'SELECT * FROM feed_sources').length, 2)
  t.is(rows(db, "SELECT * FROM feeds_fts WHERE feed_id = 'f1'").length, 1)
})
