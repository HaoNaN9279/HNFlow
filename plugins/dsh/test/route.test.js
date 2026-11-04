/**
 * The monitor route: page/notice data with no session and no command.
 *
 * `/api/hnflow/tasks` exists so the bottom-right notice can read pending tasks
 * without `remote.commands.execute`, which would append a command pair to
 * whichever session it named.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { MONITOR_PATH, createMonitorRoute } from '../lib/route.js'

test('the route is a single GET under the gateway prefix', () => {
  const route = createMonitorRoute({ service: { fileMonitor: async () => ({ runs: [], tasks: [] }) } })

  assert.equal(route.path, MONITOR_PATH)
  assert.deepEqual(route.methods, ['GET'])
  assert.equal(route.requestBody, 'buffered')
  assert.match(route.path, /^\/api\//u)
})

test('the route answers the state files as JSON and forbids caching', async () => {
  const route = createMonitorRoute({
    service: {
      fileMonitor: async () => ({ runs: [{ runId: 'run-1', status: 'waiting_human' }], tasks: [{ taskId: 'task-1', runId: 'run-1', nodeId: 'confirm' }] }),
    },
  })

  const response = await route.fetch()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.tasks[0].taskId, 'task-1')
  assert.equal(payload.runs[0].status, 'waiting_human')
})

test('an unreadable state directory answers 500 instead of throwing', async () => {
  const route = createMonitorRoute({
    service: {
      fileMonitor: async () => {
        const error = new Error('cannot read runs.json')
        error.code = 'state-unreadable'
        throw error
      },
    },
  })

  const response = await route.fetch()
  assert.equal(response.status, 500)
  const payload = await response.json()
  assert.equal(payload.ok, false)
  assert.equal(payload.error, 'state-unreadable')
})
