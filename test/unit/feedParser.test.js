import { unit as test } from '../testpup.js'
import {
  extractTag,
  extractCdata,
  extractAttr,
  isAtom,
  parseFeedTitle,
  parseFeed
} from '../../worker/feedParser.js'
import { extractFirstImage } from '../../assets/src/feedRules.js'

// fixtures

const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title><![CDATA[Test Blog]]></title>
  <link>https://example.com</link>
  <item>
    <title><![CDATA[Post Two]]></title>
    <link>https://example.com/post-two</link>
    <pubDate>Tue, 02 Jan 2024 00:00:00 GMT</pubDate>
    <description><![CDATA[<p>Content two</p>]]></description>
    <dc:creator>Jane Doe</dc:creator>
  </item>
  <item>
    <title><![CDATA[Post One]]></title>
    <link>https://example.com/post-one</link>
    <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
    <description><![CDATA[<p>Content one</p>]]></description>
  </item>
</channel>
</rss>`

const atomXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Blog</title>
  <entry>
    <title>Atom Post</title>
    <link href="https://example.com/atom-post"/>
    <published>2024-01-03T00:00:00Z</published>
    <content>Atom content here</content>
    <author><name>John Smith</name></author>
  </entry>
</feed>`

const feedConfig = { url: 'https://example.com/feed.xml' }

// extractTag

test('FeedParser: extractTag returns tag content', t => {
  t.is(extractTag('<title>Hello</title>', 'title'), 'Hello')
})

test('FeedParser: extractTag returns empty string when tag missing', t => {
  t.is(extractTag('<foo>bar</foo>', 'title'), '')
})

test('FeedParser: extractTag handles multiline content', t => {
  const xml = '<description>\n  some text\n</description>'
  t.is(extractTag(xml, 'description'), 'some text')
})

// extractCdata

test('FeedParser: extractCdata strips CDATA wrapper', t => {
  t.is(extractCdata('<![CDATA[Hello World]]>'), 'Hello World')
})

test('FeedParser: extractCdata returns plain string unchanged', t => {
  t.is(extractCdata('plain text'), 'plain text')
})

test('FeedParser: extractCdata handles html inside CDATA', t => {
  t.is(extractCdata('<![CDATA[<p>Hello</p>]]>'), '<p>Hello</p>')
})

// extractAttr

test('FeedParser: extractAttr returns attribute value', t => {
  t.is(extractAttr('<link href="https://example.com"/>', 'link', 'href'), 'https://example.com')
})

test('FeedParser: extractAttr returns empty string when attr missing', t => {
  t.is(extractAttr('<link/>', 'link', 'href'), '')
})

// isAtom

test('FeedParser: isAtom detects atom feed by xmlns', t => {
  t.ok(isAtom(atomXml))
})

test('FeedParser: isAtom returns false for rss', t => {
  t.falsy(isAtom(rssXml))
})

// parseFeedTitle

test('FeedParser: parseFeedTitle extracts title from rss', t => {
  t.is(parseFeedTitle(rssXml), 'Test Blog')
})

test('FeedParser: parseFeedTitle extracts title from atom', t => {
  t.is(parseFeedTitle(atomXml), 'Atom Blog')
})

// parseFeed (RSS)

test('FeedParser: parseFeed returns correct number of rss items', t => {
  const posts = parseFeed(rssXml, feedConfig)
  t.is(posts.length, 2)
})

test('FeedParser: parseFeed rss item has correct title', t => {
  const [first] = parseFeed(rssXml, feedConfig)
  t.is(first.title, 'Post Two')
})

test('FeedParser: parseFeed rss item has correct url', t => {
  const [first] = parseFeed(rssXml, feedConfig)
  t.is(first.url, 'https://example.com/post-two')
})

test('FeedParser: parseFeed rss item has feed metadata', t => {
  const [first] = parseFeed(rssXml, feedConfig)
  t.is(first.feed.title, 'Test Blog')
  t.is(first.feed.url, feedConfig.url)
})

test('FeedParser: parseFeed rss item extracts dc:creator as author', t => {
  const [first] = parseFeed(rssXml, feedConfig)
  t.is(first.author, 'Jane Doe')
})

test('FeedParser: parseFeed rss item author is empty string when missing', t => {
  const [, second] = parseFeed(rssXml, feedConfig)
  t.is(second.author, '')
})

// parseFeed (Atom)

test('FeedParser: parseFeed returns atom entries', t => {
  const posts = parseFeed(atomXml, { url: 'https://example.com/atom.xml' })
  t.is(posts.length, 1)
})

test('FeedParser: parseFeed atom entry has correct title', t => {
  const [first] = parseFeed(atomXml, { url: 'https://example.com/atom.xml' })
  t.is(first.title, 'Atom Post')
})

test('FeedParser: parseFeed atom entry url comes from href attr', t => {
  const [first] = parseFeed(atomXml, { url: 'https://example.com/atom.xml' })
  t.is(first.url, 'https://example.com/atom-post')
})

test('FeedParser: parseFeed atom entry extracts author name', t => {
  const [first] = parseFeed(atomXml, { url: 'https://example.com/atom.xml' })
  t.is(first.author, 'John Smith')
})

// image pipeline

test('FeedParser: parseFeed includes media:content image in content', t => {
  const xml = `<rss version="2.0"><channel><title>Blog</title>
    <item>
      <title>Post</title>
      <link>https://example.com/post</link>
      <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
      <description><![CDATA[<p>text</p>]]></description>
      <media:content url="https://example.com/hero.jpg" medium="image"/>
    </item>
  </channel></rss>`
  const [post] = parseFeed(xml, { url: 'https://example.com/feed.xml' })
  t.ok(post.content.includes('https://example.com/hero.jpg'))
})

test('FeedParser: parseFeed img in content:encoded is found by extractFirstImage', t => {
  const xml = `<rss version="2.0"><channel><title>Blog</title>
    <item>
      <title>Post</title>
      <link>https://example.com/post</link>
      <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
      <content:encoded><![CDATA[<img src="https://example.com/hero.jpg"><p>text</p>]]></content:encoded>
    </item>
  </channel></rss>`
  const [post] = parseFeed(xml, { url: 'https://example.com/feed.xml' })
  t.is(extractFirstImage(post.content), 'https://example.com/hero.jpg')
})

// feeds whose entries carry attributes parsed as empty: 19 curated blogs had no posts
test('parseFeed: blogger atom - single-quoted xmlns, entries with attributes', t => {
  const xml = [
    '<?xml version=\'1.0\' encoding=\'UTF-8\'?><feed xmlns=\'http://www.w3.org/2005/Atom\' xmlns:gd="http://schemas.google.com/g/2005"><title>Righto</title>',
    '<entry gd:etag=\'W/"abc"\'><title>One</title><link rel=\'alternate\' href=\'https://righto.test/1\'/><published>2026-11-01T00:00:00Z</published><content type=\'html\'>hi</content></entry>',
    '<entry gd:etag=\'W/"def"\'><title>Two</title><link rel=\'alternate\' href=\'https://righto.test/2\'/><published>2026-10-01T00:00:00Z</published><content type=\'html\'>yo</content></entry></feed>'
  ].join('')
  t.deepEqual(parseFeed(xml, { url: 'https://righto.test/feed' }).map(p => p.title), ['One', 'Two'])
})

test('parseFeed: atom entry with xml:lang, rss item with rdf:about', t => {
  const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry xml:lang="en"><title>Ploum</title><link rel="alternate" href="https://p.test/1"/></entry></feed>'
  t.deepEqual(parseFeed(atom, { url: 'https://p.test/atom.xml' }).map(p => p.title), ['Ploum'])
  const rss = '<rss><channel><item rdf:about="https://r.test/1"><title>Rdf</title><link>https://r.test/1</link></item><items><x/></items></channel></rss>'
  t.deepEqual(parseFeed(rss, { url: 'https://r.test/rss' }).map(p => p.title), ['Rdf'])
})

test('FeedParser: path-style categories tag by their last part; slashes mid-name stay whole', t => {
  const xml = `<rss version="2.0"><channel><title>Mile</title>
  <item><title>A</title><link>https://m.test/a</link><category>/movies/commentary/horror</category><category>/tech/coding/</category><category>AI/ML</category><description>x</description></item>
  </channel></rss>`
  const [post] = parseFeed(xml, { url: 'https://m.test/feed' })
  t.deepEqual(post.tags, ['horror', 'coding', 'aiml'])
})
