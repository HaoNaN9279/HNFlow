/**
 * The `hnflow` tool: formatting and action dispatch.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createFlowTool, formatFlows, formatRun } from '../lib/tools.js'

/**
 * A service stub with one capability flow and one run.
 * @returns {Record<string, any>} service.
 */
function stubService() {
  const run = {
    runId: 'run-1',
    flowId: 'fl',
    flowName: '测试',
    group: 'team',
    status: 'waiting_human',
    workspace: '/w',
    nodes: { draft: { status: 'done', attempts: 1 }, approve: { status: 'waiting', attempts: 0 } },
    pending: [{ id: 'gate-1', kind: 'gate', nodeId: 'approve' }],
  }
  return {
    listFlows: async () => [{ id: 'team/fl', flowId: 'fl', name: 'demo', group: 'team', requires: ['base'], description: '说明' }],
    describeFlow: async () => ({ flowId: 'fl', flowName: 'demo', group: 'team', path: '/w/.hnflow/groups/team/flows/fl.flow.json', definition: { flow: { id: 'fl' } } }),
    run: async () => ({ runId: 'run-2', status: 'running' }),
    getRun: async () => run,
    listRuns: async () => [run],
    cancel: async () => ({ runId: 'run-1', status: 'cancelled' }),
    resume: async () => ({ runId: 'run-1', status: 'running' }),
    inbox: async () => [{ id: 'gate-1', kind: 'gate', runId: 'run-1', nodeId: 'approve', whyHuman: '确认' }],
  }
}

const cwdOf = () => '/w'

test('the tool definition exposes only the capability-flow actions', () => {
  const tool = createFlowTool({ service: stubService(), cwdOf })
  assert.equal(tool.name, 'hnflow')
  assert.deepEqual(tool.parameters.properties.action.enum, [
    'list_flows',
    'describe_flow',
    'run',
    'status',
    'list_runs',
    'cancel',
    'resume',
    'inbox',
    'artifact',
    'triggers',
  ])
})

test('list_flows renders the group catalogue', async () => {
  const tool = createFlowTool({ service: stubService(), cwdOf })
  const text = await tool.execute({ action: 'list_flows' }, { agent: { session: { id: 's' } } })
  assert.match(text, /demo/u)
  assert.match(text, /group team/u)
  assert.match(text, /requires base/u)
})

test('describe_flow names the owning group and path', async () => {
  const tool = createFlowTool({ service: stubService(), cwdOf })
  const text = await tool.execute({ action: 'describe_flow', flow: 'fl' }, {})
  assert.match(text, /group team/u)
  assert.match(text, /groups\/team\/flows\/fl\.flow\.json/u)
})

test('run returns immediately and tells the model not to poll', async () => {
  const tool = createFlowTool({ service: stubService(), cwdOf })
  const text = await tool.execute({ action: 'run', flow: 'demo', input: {} }, { agent: { session: { id: 's' } } })
  assert.match(text, /started run-2/u)
  assert.match(text, /do not poll/u)
})

test('status lists node diagnostics and pending work', async () => {
  const tool = createFlowTool({ service: stubService(), cwdOf })
  const text = await tool.execute({ action: 'status', run_id: 'run-1' }, {})
  assert.match(text, /waiting_human/u)
  assert.match(text, /draft=done/u)
  assert.match(text, /1 human item/u)
})

test('a missing workspace or argument becomes an error line, not an exception', async () => {
  const tool = createFlowTool({ service: stubService(), cwdOf: () => null })
  assert.match(await tool.execute({ action: 'list_flows' }, {}), /workspace-unavailable/u)
  const tool2 = createFlowTool({ service: stubService(), cwdOf })
  assert.match(await tool2.execute({ action: 'describe_flow' }, {}), /flow-required/u)
  await assert.rejects(() => tool2.execute({ action: 'nope' }, {}), /invalid arguments/u)
})

test('formatRun and formatFlows stay compact', () => {
  assert.match(formatRun({ runId: 'r', status: 'failed', error: { code: 'x', message: 'y' }, nodes: [], pending: 0 }), /x: y/u)
  assert.equal(formatFlows([]), 'This workspace has no flows in its active capability groups.')
  const text = formatFlows([{ id: 'team/fl', flowId: 'fl', name: '演示', group: 'team', requires: ['base'], description: '说明' }])
  assert.match(text, /演示.*group team.*requires base/u)
})
