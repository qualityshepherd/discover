// The public outbound file other indexes read: real sqlite, real handler.
import { unit as test } from '../testpup.js'
import { makeDb } from '../helpers/db.js'
import { saveMentions } from '../../worker/db-mentions.js'
import { handleMentionsOutbound, OUTBOUND_DAYS } from '../../worker/mentions.js'

const NOW = Date.UTC(2026, 10, 23, 12)
const sqlTime = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19)

const m = (post, toUrl, extra = {}) => ({
  fromSource: 'https://a.test/feed',
  fromPost: post,
  fromTitle: 'Title of ' + post,
  fromDate: 'Fri, 20 Nov 2026 18:16:29 GMT',
  fromContent: '<p>the whole post body</p>',
  toUrl,
  ...extra
})

const seed = async (db, domain, list, foundMs) => {
  await saveMentions(db, domain, list)
  db.sqlite.prepare('UPDATE mentions SET found_at=? WHERE to_domain=?').run(sqlTime(foundMs), domain)
}

const outbound = async db => {
  const res = await handleMentionsOutbound(db, NOW)
  return { res, body: await res.json() }
}

test('outbound: one entry per post, every link it made, no post body', async t => {
  const db = makeDb()
  await seed(db, 'bob.test', [m('https://a.test/roundup', 'https://bob.test/x'), m('https://a.test/roundup', 'https://bob.test/y')], NOW - 86400000)
  await seed(db, 'carol.test', [m('https://a.test/roundup', 'https://carol.test/')], NOW - 86400000)
  const { res, body } = await outbound(db)
  t.is(body.version, 1)
  t.is(body.spec, 'https://discover.brine.dev/mentions-spec')
  t.is(body.mentions.length, 1)
  const [entry] = body.mentions
  t.is(entry.post, 'https://a.test/roundup')
  t.is(entry.title, 'Title of https://a.test/roundup')
  t.is(entry.date, '2026-11-20T18:16:29.000Z')
  t.deepEqual([...entry.links].sort(), ['https://bob.test/x', 'https://bob.test/y', 'https://carol.test/'])
  t.ok(!JSON.stringify(body).includes('whole post body'))
  t.is(res.headers.get('Access-Control-Allow-Origin'), '*')
})

test('outbound: only the rolling window, by when discover found it', async t => {
  const db = makeDb()
  await seed(db, 'bob.test', [m('https://a.test/new', 'https://bob.test/x')], NOW - 86400000)
  await seed(db, 'carol.test', [m('https://a.test/old', 'https://carol.test/x')], NOW - (OUTBOUND_DAYS + 1) * 86400000)
  const { body } = await outbound(db)
  t.deepEqual(body.mentions.map(e => e.post), ['https://a.test/new'])
})

test('outbound: double-escaped hrefs come out as real urls, junk is dropped', async t => {
  const db = makeDb()
  await seed(db, 'bob.test', [
    m('https://a.test/p', 'https://bob.test/x?a=1&amp;amp;b=2'),
    m('https://a.test/p', 'mailto:bob@bob.test')
  ], NOW - 86400000)
  const { body } = await outbound(db)
  t.deepEqual(body.mentions[0].links, ['https://bob.test/x?a=1&b=2'])
})

test('outbound: unparseable post date is null, not a lie', async t => {
  const db = makeDb()
  await seed(db, 'bob.test', [m('https://a.test/p', 'https://bob.test/x', { fromDate: 'sometime' })], NOW - 86400000)
  const { body } = await outbound(db)
  t.is(body.mentions[0].date, null)
})
