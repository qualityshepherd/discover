// The whole mentions-for-a-post feature rides on this: the href a feed
// contained has to match the URL a browser reports for the same page,
// despite http/https, www, trailing slashes, hashes and tracking params.
import { unit as test } from '../testpup.js'
import { urlMatchKey } from '../../worker/url-normalize.js'

test('urlMatchKey: a plain url keys to host + path', t => {
  t.is(urlMatchKey('https://bob.test/my-post'), 'bob.test/my-post')
})

test('urlMatchKey: protocol does not matter', t => {
  t.is(urlMatchKey('http://bob.test/my-post'), urlMatchKey('https://bob.test/my-post'))
})

test('urlMatchKey: www and host case are stripped', t => {
  t.is(urlMatchKey('https://WWW.Bob.Test/my-post'), 'bob.test/my-post')
})

test('urlMatchKey: trailing slash does not matter', t => {
  t.is(urlMatchKey('https://bob.test/my-post/'), urlMatchKey('https://bob.test/my-post'))
})

test('urlMatchKey: the bare root and the slash root match', t => {
  t.is(urlMatchKey('https://bob.test'), urlMatchKey('https://bob.test/'))
})

test('urlMatchKey: fragments are dropped', t => {
  t.is(urlMatchKey('https://bob.test/my-post#section-2'), 'bob.test/my-post')
})

test('urlMatchKey: tracking params are dropped', t => {
  t.is(urlMatchKey('https://bob.test/my-post?utm_source=mastodon&utm_medium=social&fbclid=x&gclid=y&ref=feed'), 'bob.test/my-post')
})

// wordpress default permalinks are /?p=123 - strip those and every post
// on such a blog collapses into the homepage
test('urlMatchKey: real query params survive', t => {
  t.is(urlMatchKey('https://bob.test/?p=123'), 'bob.test?p=123')
  t.not(urlMatchKey('https://bob.test/?p=123'), urlMatchKey('https://bob.test/?p=124'))
})

test('urlMatchKey: param order does not matter', t => {
  t.is(urlMatchKey('https://bob.test/x?a=1&b=2'), urlMatchKey('https://bob.test/x?b=2&a=1'))
})

test('urlMatchKey: path case is preserved', t => {
  t.not(urlMatchKey('https://bob.test/My-Post'), urlMatchKey('https://bob.test/my-post'))
})

test('urlMatchKey: garbage returns null', t => {
  t.is(urlMatchKey('not a url'), null)
  t.is(urlMatchKey(''), null)
  t.is(urlMatchKey(null), null)
  t.is(urlMatchKey('mailto:bob@bob.test'), null)
})
