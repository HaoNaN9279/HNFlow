/**
 * `/hnflow`: listing runs and flows. No publish, revision or library verb.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createFlowCommand } from '../lib/commands.js'

const cwdOf = () => '/w'

/**
 * A command over a service stub.
 * @param {Record<string, any>} service - stub.
 * @returns {Record<string, any>} command.
 */
function command(service) {
  return createFlowCommand({ service, cwdOf, config: {}, logger: {} })
}

const service = {
  listFlows: async () => [{ id: 'team/fl', flowId: 'fl', name: '演示', group: 'team', module: null, requires: ['base'], description: '说明' }],
  listRuns: async () => [],
  getRun: async () => ({
    runId: 'run-1',
    flowId: 'fl',
    flowName: '演示',
    status: 'waiting_human',
    nodes: { draft: { status: 'done', attempts: 1 }, approve: { status: 'waiting', attempts: 0 } },
    pending: [{ id: 'gate-1' }],
  }),
  inbox: async () => [{ id: 'gate-1', kind: 'gate', runId: 'run-1', nodeId: 'approve' }],
}

test('usage and unknown subcommands never throw', async () => {
  assert.match((await command(service).handler({ rawInput: '' })).text, /HNFlow 用法/u)
  const unknown = await command(service).handler({ rawInput: 'publish' })
  assert.equal(unknown.kind, 'error')
  assert.match(unknown.text, /未知子命令/u)
})

test('list names the owning capability group', async () => {
  const text = (await command(service).handler({ rawInput: 'list' })).text
  assert.match(text, /演示/u)
  assert.match(text, /能力组 team/u)
})

test('status renders the node timeline', async () => {
  const text = (await command(service).handler({ rawInput: 'status run-1' })).text
  assert.match(text, /waiting_human/u)
  assert.match(text, /draft: done/u)
})
