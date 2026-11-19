import { unit as test } from '../testpup.js'
import { isBlocked, isUrlBlocked } from '../../worker/db-moderation.js'

// isBlocked
//
const fakeBlockedDb = (list) => ({
  prepare: () => ({ all: async () => ({ results: list.map(d => ({ domain: d })) }) })
})

test('isBlocked: returns false when blocked list is empty', async t => {
  t.falsy(await isBlocked(fakeBlockedDb([]), ['https://example.com/feed.xml']))
})

test('isBlocked: matches full URL substring', async t => {
  t.ok(await isBlocked(fakeBlockedDb(['badsite.com']), ['https://badsite.com/feed.xml']))
})

test('isBlocked: matches hostname with www stripped', async t => {
  t.ok(await isBlocked(fakeBlockedDb(['badsite.com']), ['https://www.badsite.com/feed.xml']))
})

test('isBlocked: does not block unrelated domain', async t => {
  t.falsy(await isBlocked(fakeBlockedDb(['badsite.com']), ['https://goodsite.com/feed.xml']))
})

test('isBlocked: returns true if any source matches', async t => {
  t.ok(await isBlocked(fakeBlockedDb(['badsite.com']), ['https://ok.com/feed.xml', 'https://badsite.com/feed.xml']))
})

test('isBlocked: handles invalid url without throwing', async t => {
  t.falsy(await isBlocked(fakeBlockedDb(['badsite.com']), ['not-a-url']))
})

// isUrlBlocked — hostname-exact-or-subdomain match, not a bare substring
// check. Regression coverage for the handleValidate bug where an inline
// url.includes(b)/hostname.includes(b) check would wrongly match domains
// that merely contain a blocked domain as a substring.
test('isUrlBlocked: exact hostname match', t => {
  t.ok(isUrlBlocked('https://badsite.com/feed.xml', ['badsite.com']))
})

test('isUrlBlocked: does not match a domain that merely contains the blocked domain as a substring', t => {
  t.falsy(isUrlBlocked('https://notbadsite.com/feed.xml', ['badsite.com']))
  t.falsy(isUrlBlocked('https://badsite.com.evil.org/feed.xml', ['badsite.com']))
})

test('isUrlBlocked: matches a real subdomain', t => {
  t.ok(isUrlBlocked('https://feed.badsite.com/feed.xml', ['badsite.com']))
})
