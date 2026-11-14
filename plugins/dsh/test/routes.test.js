/**
 * The Fetch routes: registration shape, GET snapshots, POST dispatch and error
 * mapping. No HTTP server is involved — each route takes a `Request`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { ROUTES, createRoutes } from '../lib/routes.js'

/**
 * A service stub recording every call.
 * @returns {Record<string, any>} service.
 */
function stubService() {
  const calls = []
  return {
    calls,
    snapshot: async (workspaces) => ({ ok: true, workspaces, runs: [], inbox: [] }),
    inbox: async () => ({ ok: true, items: [] }),
    getRun: async (runId) => {
      calls.push({ kind: 'getRun', runId })
      return { runId, status: 'waiting_human', nodes: {}, pending: [] }
    },
    describeFlow: async (workspace, key) => ({ flowId: key, workspace, definition: { nodes: [] } }),
    decide: async (input) => {
      calls.push({ kind: 'decide', ...input })
      return { runId: input.runId, status: 'running', settled: Promise.resolve(null) }
    },
    deliver: async (input) => {
      calls.push({ kind: 'deliver', ...input })
      return { runId: input.runId, status: 'running', settled: Promise.resolve(null) }
    },
    run: async (input) => {
      calls.push({ kind: 'run', ...input })
      return { runId: 'run-new', status: 'running', settled: Promise.resolve(null) }
    },
  }
}

/**
 * Find one route.
 * @param {Record<string, any>[]} routes - route list.
 * @param {string} path - route path.
 * @returns {Record<string, any>} route.
 */
function route(routes, path) {
  const found = routes.find((entry) => entry.path === path)
  assert.notEqual(found, undefined, `no route ${path}`)
  return found
}

/**
 * POST JSON to a route.
 * @param {Record<string, any>} entry - route.
 * @param {Record<string, any>} body - body.
 * @returns {Promise<Record<string, any>>} parsed response.
 */
async function post(entry, body) {
  const response = await entry.fetch(new Request(`http://host${entry.path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }))
  return { status: response.status, body: await response.json() }
}

test('every surface route is registered with an explicit method list', () => {
  const routes = createRoutes({ service: stubService() })
  assert.deepEqual(routes.map((entry) => entry.path).sort(), Object.values(ROUTES).sort())
  for (const entry of routes) {
    assert.equal(Array.isArray(entry.methods), true)
    assert.equal(entry.requestBody, 'buffered')
  }
})

test('GET state passes each workspace through', async () => {
  const service = stubService()
  const routes = createRoutes({ service })
  const response = await route(routes, ROUTES.state).fetch(new Request(`http://host${ROUTES.state}?workspace=/a&workspace=/b`))
  const body = await response.json()
  assert.deepEqual(body.workspaces.map((workspace) => workspace.path), ['/a', '/b'])
})

test('GET run validates its query and returns the record', async () => {
  const service = stubService()
  const entry = route(createRoutes({ service }), ROUTES.run)
  const missing = await entry.fetch(new Request(`http://host${ROUTES.run}`))
  assert.equal(missing.status, 400)
  const found = await entry.fetch(new Request(`http://host${ROUTES.run}?runId=run-1`))
  assert.equal((await found.json()).run.runId, 'run-1')
})

test('GET flow resolves one definition', async () => {
  const entry = route(createRoutes({ service: stubService() }), ROUTES.flow)
  const response = await entry.fetch(new Request(`http://host${ROUTES.flow}?workspace=/w&flow=demo`))
  const body = await response.json()
  assert.equal(body.flow.flowId, 'demo')
})

test('POST gate forwards the decision and does not await the run', async () => {
  const service = stubService()
  const result = await post(route(createRoutes({ service }), ROUTES.gate), { runId: 'run-1', gateId: 'gate-1', decision: 'approved', revision: 3 })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.deepEqual(service.calls[0], { kind: 'decide', runId: 'run-1', gateId: 'gate-1', decision: 'approved', reason: undefined, revision: 3, artifact: undefined })
})

test('POST deliverable forwards the payload', async () => {
  const service = stubService()
  const result = await post(route(createRoutes({ service }), ROUTES.deliverable), { runId: 'run-1', requestId: 'req-1', payload: { files: [] }, revision: 1 })
  assert.equal(result.body.ok, true)
  assert.equal(service.calls[0].kind, 'deliver')
})

test('POST start validates its required fields', async () => {
  const service = stubService()
  const routes = createRoutes({ service })
  const bad = await post(route(routes, ROUTES.start), { flow: 'demo' })
  assert.equal(bad.status, 400)
  const started = await post(route(routes, ROUTES.start), { workspace: '/w', flow: 'demo', input: { brief: 'x' } })
  assert.equal(started.body.runId, 'run-new')
})

test('invalid JSON and service errors map to JSON failures', async () => {
  const entry = route(createRoutes({ service: stubService() }), ROUTES.gate)
  const invalid = await entry.fetch(new Request(`http://host${ROUTES.gate}`, { method: 'POST', body: 'not json', headers: { 'content-type': 'application/json' } }))
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).code, 'invalid-json')

  const failing = createRoutes({
    service: {
      ...stubService(),
      decide: async () => {
        throw Object.assign(new Error('already decided'), { code: 'already-decided' })
      },
    },
  })
  const failure = await post(route(failing, ROUTES.gate), { runId: 'r', gateId: 'g', decision: 'approved' })
  assert.equal(failure.status, 409)
  assert.equal(failure.body.code, 'already-decided')
})
