import { unit as test } from '../testpup.js'
import { computeFrequency, readLimitedText, feedInfo } from '../../worker/fetch-source.js'

// computeFrequency

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()

test('computeFrequency: no posts returns null', t => {
  t.is(computeFrequency([]), null)
  t.is(computeFrequency(null), null)
})

test('computeFrequency: all posts older than 90 days returns inactive', t => {
  const posts = Array.from({ length: 5 }, () => ({ date: daysAgo(100) }))
  t.is(computeFrequency(posts), 'inactive')
})

test('computeFrequency: 2-7 posts in 90 days returns monthly', t => {
  const posts = Array.from({ length: 3 }, () => ({ date: daysAgo(15) }))
  t.is(computeFrequency(posts), 'monthly')
})

test('computeFrequency: 1 post in 90 days returns inactive', t => {
  const posts = [{ date: daysAgo(15) }]
  t.is(computeFrequency(posts), 'inactive')
})

test('computeFrequency: posts with no date are ignored', t => {
  const posts = [{ date: null }, { date: '' }, { date: daysAgo(5) }, { date: daysAgo(10) }]
  t.is(computeFrequency(posts), 'monthly')
})

test('computeFrequency: exactly 20 posts returns daily', t => {
  const posts = Array.from({ length: 20 }, () => ({ date: daysAgo(1) }))
  t.is(computeFrequency(posts), 'daily')
})

test('computeFrequency: exactly 8 posts returns weekly', t => {
  const posts = Array.from({ length: 8 }, () => ({ date: daysAgo(1) }))
  t.is(computeFrequency(posts), 'weekly')
})

// readLimitedText — enforces fetchSource's response-size cap by counting
// streamed bytes, not trusting Content-Length.
const streamOf = (chunks) => new Response(new ReadableStream({
  start (controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
    controller.close()
  }
}))

test('readLimitedText: returns full text under the limit', async t => {
  t.is(await readLimitedText(streamOf(['hello ', 'world']), 1000), 'hello world')
})

test('readLimitedText: exact boundary is not rejected', async t => {
  t.is(await readLimitedText(streamOf(['abcde']), 5), 'abcde')
})

test('readLimitedText: returns null when the stream exceeds the byte limit', async t => {
  t.is(await readLimitedText(streamOf(['a'.repeat(50)]), 10), null)
})

test('feedInfo: language and generator from the channel, not the items', t => {
  t.deepEqual(feedInfo('<rss><channel><language>en-us</language><generator><![CDATA[Substack]]></generator><item><language>de</language></item>'),
    { language: 'en-us', generator: 'Substack' })
  t.deepEqual(feedInfo('<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="fr"><generator uri="https://gohugo.io/">Hugo</generator><entry>'),
    { language: 'fr', generator: 'Hugo' })
  t.deepEqual(feedInfo('<rss><channel><title>x</title>'), { language: null, generator: null })
})
