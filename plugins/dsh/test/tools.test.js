/**
 * The `hnflow` tool: formatting and action dispatch.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createFlowTool, formatFlows, formatRun } from '../lib/tools.js'

/** `defineTool` stand-in that returns the definition it receives. */
const defineTool = (definition) => definition

/**
 * A service stub with one flow and one run.
 * @returns {Record<string, any>} service.
 */
function stubService() {
  const run = {
    runId: 'run-1',
    flowId: 'fl',
    flowName: '测试',
    key: 'demo',
    revision: 1,
    status: 'waiting_human',
    workspace: '/w',
    nodes: { draft: { status: 'done', attempts: 1 }, approve: { status: 'waiting', attempts: 0 } },
    pending: [{ id: 'gate-1', kind: 'gate', nodeId: 'approve' }],
  }
  return {
    listFlows: async () => [{ alias: 'demo', flowId: 'fl', pinnedRevision: null, currentRevision: 1, hasOverride: false, drift: false, missing: false, description: '说明' }],
    describeFlow: async () => ({ alias: 'demo', flowId: 'fl', source: 'latest', revision: 1, currentRevision: 1, drift: false, definition: { flow: { id: 'fl' } } }),
    run: async () => ({ runId: 'run-2', status: 'running' }),
    getRun: async () => run,
    cancel: async () => ({ runId: 'run-1', status: 'cancelled' }),
    resume: async () => ({ runId: 'run-1', status: 'running' }),
    inbox: async () => [{ id: 'gate-1', kind: 'gate', runId: 'run-1', nodeId: 'approve', whyHuman: '确认' }],
  }
}

const cwdOf = () => '/w'

test('the tool definition exposes only non-publishing actions', () => {
  const tool = createFlowTool({ defineTool, service: stubService(), cwdOf })
  assert.equal(tool.name, 'hnflow')
  assert.deepEqual(tool.parameters.action.enum, ['list_flows', 'describe_flow', 'run', 'status', 'cancel', 'resume', 'inbox'])
})

test('list_flows renders the catalogue', async () => {
  const tool = createFlowTool({ defineTool, service: stubService(), cwdOf })
  const text = await tool.execute({ action: 'list_flows' }, { agent: { session: { id: 's' } } })
  assert.match(text, /demo/u)
  assert.match(text, /r1 \(follows latest\)/u)
})

test('run returns immediately and tells the model not to poll', async () => {
  const tool = createFlowTool({ defineTool, service: stubService(), cwdOf })
  const text = await tool.execute({ action: 'run', flow: 'demo', input: {} }, { agent: { session: { id: 's' } } })
  assert.match(text, /started run-2/u)
  assert.match(text, /do not poll/u)
})

test('status lists node diagnostics and pending work', async () => {
  const tool = createFlowTool({ defineTool, service: stubService(), cwdOf })
  const text = await tool.execute({ action: 'status', run_id: 'run-1' }, {})
  assert.match(text, /waiting_human/u)
  assert.match(text, /draft=done/u)
  assert.match(text, /1 human item/u)
})

test('a missing workspace or argument becomes an error line, not an exception', async () => {
  const tool = createFlowTool({ defineTool, service: stubService(), cwdOf: () => null })
  assert.match(await tool.execute({ action: 'list_flows' }, {}), /workspace-unavailable/u)
  const tool2 = createFlowTool({ defineTool, service: stubService(), cwdOf })
  assert.match(await tool2.execute({ action: 'describe_flow' }, {}), /flow-required/u)
  assert.match(await tool2.execute({ action: 'nope' }, {}), /invalid-action/u)
})

test('formatRun and formatFlows stay compact', () => {
  assert.match(formatRun({ runId: 'r', status: 'failed', error: { code: 'x', message: 'y' }, nodes: [], pending: 0 }), /x: y/u)
  assert.equal(formatFlows([]), 'This workspace references no HNFlow flows.')
})
