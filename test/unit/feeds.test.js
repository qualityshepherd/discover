import { unit as test } from '../testpup.js'
import { makeId } from '../../worker/db-sources.js'
import { computeTags } from '../../worker/db-feeds.js'

// makeId

test('makeId: same url returns same id', t => {
  t.is(makeId('https://example.com/feed.xml'), makeId('https://example.com/feed.xml'))
})

test('makeId: different urls return different ids', t => {
  t.not(makeId('https://example.com/feed.xml'), makeId('https://other.com/feed.xml'))
})

// computeTags

test('computeTags: counts tags across feeds', t => {
  const feeds = [
    { tags: ['tech', 'essays'] },
    { tags: ['tech', 'science'] },
    { tags: ['essays'] }
  ]
  const result = computeTags(feeds)
  const techEntry = result.find(r => r.tag === 'tech')
  const essaysEntry = result.find(r => r.tag === 'essays')
  t.is(techEntry.count, 2)
  t.is(essaysEntry.count, 2)
})

test('computeTags: sorts by count descending', t => {
  const feeds = [
    { tags: ['rare'] },
    { tags: ['common', 'common2'] },
    { tags: ['common'] },
    { tags: ['common'] }
  ]
  const result = computeTags(feeds)
  t.is(result[0].tag, 'common')
})

test('computeTags: handles feeds with no tags', t => {
  const feeds = [{ tags: ['tech'] }, {}, { tags: null }]
  const result = computeTags(feeds)
  t.is(result.length, 1)
  t.is(result[0].tag, 'tech')
})

test('computeTags: empty feeds returns empty array', t => {
  t.deepEqual(computeTags([]), [])
})
