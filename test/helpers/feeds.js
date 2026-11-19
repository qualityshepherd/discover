// fake feeds and posts for the curate and feed-stats tests

export const DAY = 86400000

// a feed that passes every check: full posts, a few a month, one author, recent
export const goodPosts = (n = 4, { len = 800, every = 10, author = 'me', start = Date.now() - DAY, extra = '' } = {}) =>
  Array.from({ length: n }, (_, i) => ({
    content: `<p>${'word '.repeat(len / 5)}</p>${extra}`,
    date: new Date(start - i * every * DAY).toUTCString(),
    author
  }))

export const feedOf = (posts, more = {}) => ({ feedUrl: 'https://found.example.com/feed', posts, ...more })

export const makePost = (links) => ({
  content: links.map(href => `<a href="${href}">link</a>`).join(' ')
})

// [[feedUrl, [links...]], ...] -> the freshData map the cron hands over
export const makeFreshData = (entries) => new Map(
  entries.map(([url, links]) => [url, { posts: [makePost(links)] }])
)
