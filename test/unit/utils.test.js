import { unit as test } from '../testpup.js'
import { sameBlog, blogDomain, bareHost } from '../../worker/utils.js'

test('blogDomain: site url, then post urls, then the feed itself', t => {
  t.is(blogDomain('https://feeds.feedburner.com/x', { siteUrl: 'https://www.real.blog/' }), 'real.blog')
  t.is(blogDomain('https://feeds.feedburner.com/x', { posts: [{ url: 'https://real.blog/p' }] }), 'real.blog')
  t.is(blogDomain('https://real.blog/feed', {}), 'real.blog')
})

// dupes

test('sameBlog: www, scheme and feed path do not make a new blog', t => {
  const have = ['https://example.com/feed', 'https://other.blog/rss.xml']
  t.is(sameBlog('http://www.example.com/rss.xml', have), 'https://example.com/feed')
  t.is(sameBlog('https://Example.com/atom.xml', have), 'https://example.com/feed')
  t.is(sameBlog('https://sub.example.com/feed', have), null)
  t.is(sameBlog('not a url', have), null)
})

test('bareHost: no www, lowercase, empty for junk', t => {
  t.is(bareHost('https://WWW.Example.com/x'), 'example.com')
  t.is(bareHost('mailto:me@x.com'), '')
  t.is(bareHost(undefined), '')
})
