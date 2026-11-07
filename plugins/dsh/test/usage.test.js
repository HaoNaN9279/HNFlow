/**
 * Token usage attribution: read from the live child session, never guessed.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { rm } from 'node:fs/promises'

import { gateFlow, makeService, seedWorkspace } from './helpers.js'

/**
 * Build a live-session fake with two model calls.
 * @returns {Record<string, any>} session.
 */
function usageSession() {
  return {
    snapshotEvents: () => [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2 } } },
      { type: 'assistant/message', data: { usage: { inputTokens: 6, outputTokens: 5 } } },
      { type: 'turn/end', data: { turn: 1 } },
    ],
  }
}

test('a node carries the usage of its child session and the run sums it', async () => {
  const seeded = await seedWorkspace(gateFlow())
  const sessions = {
    get: (id) => (id === 'child-draft-0' ? usageSession() : undefined),
  }
  const service = await makeService({
    script: { draft: [{ status: 'done', output: { points: [] } }] },
    config: { libraryRoot: seeded.library },
    sessions,
  })
  try {
    const run = await (await service.run({ cwd: seeded.workspace, key: 'demo', input: { brief: 'x' } })).settled
    assert.deepEqual(run.nodes.draft.usage, {
      inputTokens: 16,
      outputTokens: 9,
      totalTokens: 25,
      cacheReadTokens: 2,
      cacheWriteTokens: 0,
      calls: 2,
    })
    assert.equal(run.usage.totalTokens, 25)
    const summary = (await service.snapshot([{ path: seeded.workspace }])).runs[0]
    assert.equal(summary.usage.totalTokens, 25)
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('without a live child session the usage stays unknown rather than estimated', async () => {
  const seeded = await seedWorkspace(gateFlow())
  const service = await makeService({ script: { draft: [{ status: 'done', output: { points: [] } }] }, config: { libraryRoot: seeded.library } })
  try {
    const run = await (await service.run({ cwd: seeded.workspace, key: 'demo', input: { brief: 'x' } })).settled
    assert.equal(run.nodes.draft.usage, undefined)
    assert.equal(run.usage, null)
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})
