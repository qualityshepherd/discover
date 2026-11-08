import { unit as test } from '../testpup.js'
import { isSpaRoute } from '../../worker/index.js'

// every path discover.js's route() handles needs to be listed here too -
// missing one works fine via pushState but 404s on refresh. bit us twice
// (/tag/*, /filters) before this test existed
const CLIENT_ROUTES = ['/', '/new', '/random', '/filters', '/tag/ai', '/tag/solarpunk']

test('isSpaRoute: every known client-side route is covered', t => {
  for (const path of CLIENT_ROUTES) t.ok(isSpaRoute(path), path)
})

// /discover/:id is a client route too but not part of isSpaRoute on
// purpose - it needs its own D1-backed block, not the plain shell. just
// checking isSpaRoute doesn't swallow it and make that block unreachable
test('isSpaRoute: does not swallow /discover/:id - that has its own dedicated block', t => {
  t.falsy(isSpaRoute('/discover/some-slug'))
})

test('isSpaRoute: does not match unrelated pages', t => {
  for (const path of ['/about', '/admin', '/sitemap.xml', '/api/discover', '/api/discover/new']) {
    t.falsy(isSpaRoute(path), path)
  }
})
