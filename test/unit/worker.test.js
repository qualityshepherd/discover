import { unit as test } from '../testpup.js'
import { classifyHit } from '../../worker/analytics.js'

// classifyHit — covers all branching in trackHit without touching CF infra
test('classifyHit: bot path returns bot', t => {
  t.is(classifyHit('/wp-login.php', 'Mozilla/5.0'), 'bot')
})

test('classifyHit: normal path + browser ua returns hit', t => {
  t.is(classifyHit('/posts/hello', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'hit')
})

test('classifyHit: root path returns hit', t => {
  t.is(classifyHit('/', 'Mozilla/5.0'), 'hit')
})

test('classifyHit: path with query string returns hit', t => {
  t.is(classifyHit('/?t=javascript', 'Mozilla/5.0'), 'hit')
})

test('classifyHit: skip takes priority over bot path', t => {
  // /api/something that also looks like a bot path should still skip
  t.is(classifyHit('/api/graphql'), 'skip')
})
