import { unit as test } from '../testpup.js'
import { handleMentionsFeed, MENTIONS_FEED_FULL } from '../../worker/mentions.js'
import { makeDb } from '../helpers/db.js'
import { makeId, saveSourceData } from '../../worker/db-sources.js'

// newest first, the way getMentions' ORDER BY found_at DESC hands them over
const rows = n => Array.from({ length: n }, (_, i) => ({
  from_source: 'https://other.blog/feed.xml',
  from_post: `https://other.blog/post-${i}`,
  from_title: `Post ${i}`,
  from_date: null,
  from_content: `<p>words of post ${i}</p>`,
  to_url: 'https://brine.dev/x',
  found_at: new Date(Date.UTC(2026, 10, 18) - i * 86400000).toISOString()
}))

const stubDb = results => ({ prepare: () => ({ bind: () => ({ all: async () => ({ results }) }) }) })

const feed = async n => (await handleMentionsFeed(stubDb(rows(n)), 'brine.dev', 'https://discover.brine.dev/api/mentions/brine.dev.xml')).text()

test('mentions feed: newest ones carry the full post', async t => {
  const xml = await feed(MENTIONS_FEED_FULL + 5)
  t.ok(xml.includes('words of post 0'))
  t.ok(xml.includes(`words of post ${MENTIONS_FEED_FULL - 1}`))
})

test('mentions feed: older ones are a link, not a copy', async t => {
  const xml = await feed(MENTIONS_FEED_FULL + 5)
  t.ok(!xml.includes(`words of post ${MENTIONS_FEED_FULL}`))
  t.ok(xml.includes(`<a href="https://other.blog/post-${MENTIONS_FEED_FULL}">Read it on other.blog</a>`))
  // still listed, just without the words
  t.ok(xml.includes(`<title>Post ${MENTIONS_FEED_FULL + 4}</title>`))
})

test('mentions feed: an old id url 301s to the domain feed', async t => {
  const db = makeDb()
  await saveSourceData(db, 'https://zylstra.org/blog/feed', { siteUrl: 'https://www.zylstra.org/blog/', posts: [] })
  const res = await handleMentionsFeed(db, makeId('https://zylstra.org/blog/feed'), 'https://discover.brine.dev/api/mentions/y8hbr4.xml')
  t.is(res.status, 301)
  t.is(res.headers.get('Location'), 'https://discover.brine.dev/api/mentions/zylstra.org.xml')
})

test('mentions feed: an unknown id is still just an empty feed', async t => {
  const res = await handleMentionsFeed(makeDb(), 'nope00', 'https://discover.brine.dev/api/mentions/nope00.xml')
  t.is(res.status, 200)
  t.ok(!(await res.text()).includes('<item>'))
})
