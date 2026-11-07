/**
 * The subagent seam is resolved lazily: the core row is composed before the
 * subagent plugin mounts, so capturing the service at construction would make
 * every node fail with `subagent-unavailable`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createSubagentRunner, withTimeout } from '../lib/runner.js'

test('the runner sees a subagent service that mounts after construction', async () => {
  let service
  const runner = createSubagentRunner({ subagents: () => service })
  assert.equal(runner.available(), false)
  await assert.rejects(() => runner.spawn({ label: 'r/n#1', prompt: 'x', outputSchema: { type: 'object' }, cwd: '/w', preset: 'hnflow', parent: { id: 'p' } }), (error) => error.code === 'subagent-unavailable')

  service = {
    startActivation: async (spec) => ({
      childId: 'child-1',
      result: Promise.resolve({ stopReason: 'completed', output: [], structured: { status: 'done', output: { ok: true } } }),
      dispose: async () => {},
      spec,
    }),
  }
  assert.equal(runner.available(), true)
  const activation = await runner.spawn({ label: 'r/n#1', prompt: 'x', outputSchema: { type: 'object' }, cwd: '/w', preset: 'hnflow', parent: { id: 'p' } })
  assert.equal(activation.childId, 'child-1')
  const result = await activation.result
  assert.deepEqual(result.structured, { status: 'done', output: { ok: true } })
})

test('withTimeout reports the timeout instead of rejecting', async () => {
  const quick = await withTimeout(Promise.resolve(7), 1000)
  assert.deepEqual(quick, { timedOut: false, value: 7 })
  const slow = await withTimeout(new Promise(() => {}), 10)
  assert.equal(slow.timedOut, true)
})
