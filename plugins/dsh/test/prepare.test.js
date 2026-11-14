/**
 * The workspace prepare route.
 *
 * Selecting HNFlow on a fresh window must initialise the workspace instead of
 * leaving the composer and the preview waiting for a plan. The route is the one
 * seam the client calls the moment the mode changes, so it has to answer even
 * when the workspace cannot be initialised — with a reason, never a throw.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { PREPARE_PATH, createPrepareRoute } from '../capability/lib/prepare-route.js'

/**
 * Call the route the way Connection would.
 * @param {{fetch: (request: Request) => Promise<Response>}} route - route.
 * @param {string} query - query string, leading `?` included.
 * @returns {Promise<{status: number, body: Record<string, any>, cacheControl: string | null}>} response shards.
 */
async function call(route, query) {
  const response = await route.fetch(new Request(`http://127.0.0.1${PREPARE_PATH}${query}`))
  return {
    status: response.status,
    body: await response.json(),
    cacheControl: response.headers.get('cache-control'),
  }
}

test('the prepare route requires a session id', async () => {
  const route = createPrepareRoute({ prepareForSession: async () => ({ ready: true }) })
  const { status, body } = await call(route, '')
  assert.equal(status, 400)
  assert.equal(body.ok, false)
  assert.equal(body.code, 'missing-session')
})

test('a ready workspace reports the initialised stack', async () => {
  /** @type {{sessionId: string, hint: string | undefined} | null} */
  let seen = null
  const route = createPrepareRoute({
    prepareForSession: async (sessionId, hint) => {
      seen = { sessionId, hint }
      return { ready: true, cwd: '.', project: 'D:/w', created: true, warnings: [] }
    },
  })
  const { status, body, cacheControl } = await call(route, '?sessionId=s1&cwd=D%3A%2Fw')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.ready, true)
  assert.equal(body.created, true)
  assert.equal(body.project, 'D:/w')
  assert.deepEqual(seen, { sessionId: 's1', hint: 'D:/w' })
  assert.equal(cacheControl, 'no-store')
})

test('an unusable workspace answers with the reason and the warnings', async () => {
  const route = createPrepareRoute({
    prepareForSession: async () => ({
      ready: false,
      cwd: null,
      reason: 'resolve returned no plan',
      warnings: ['hnflow-stack resolve failed: spawn EPERM'],
    }),
  })
  const { status, body } = await call(route, '?sessionId=s1')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.ready, false)
  assert.equal(body.reason, 'resolve returned no plan')
  assert.deepEqual(body.warnings, ['hnflow-stack resolve failed: spawn EPERM'])
})

test('a failing prepare keeps the status and the code', async () => {
  const route = createPrepareRoute({
    prepareForSession: async () => {
      const error = new Error('no usable Capability plan for D:/w (resolve returned no plan)')
      error.code = 'missing-plan'
      error.status = 404
      error.details = { cwd: ['D:/w'], reason: 'resolve returned no plan', warnings: [] }
      throw error
    },
  })
  const { status, body } = await call(route, '?sessionId=s1')
  assert.equal(status, 404)
  assert.equal(body.ok, false)
  assert.equal(body.code, 'missing-plan')
  assert.match(body.message, /no usable Capability plan/u)
  assert.equal(body.details.reason, 'resolve returned no plan')
})
