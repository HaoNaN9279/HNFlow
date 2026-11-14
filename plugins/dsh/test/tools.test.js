/**
 * The `hnflow` tool: formatting and action dispatch.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createFlowTool, formatFlows, formatLibrary, formatRun } from '../lib/tools.js'

/**
 * A service stub with one flow and one run.
 * @returns {Record<string, any>} service.
 */
function stubService() {
  const run = {
    runId: 'run-1',
    flowId: 'fl',
    flowName: '娴嬭瘯',
    key: 'demo',
    revision: 1,
    status: 'waiting_human',
    workspace: '/w',
    nodes: { draft: { status: 'done', attempts: 1 }, approve: { status: 'waiting', attempts: 0 } },
    pending: [{ id: 'gate-1', kind: 'gate', nodeId: 'approve' }],
  }
  return {
    listFlows: async () => [{ alias: 'demo', flowId: 'fl', name: 'demo', pinnedRevision: null, currentRevision: 1, hasOverride: false, drift: false, missing: false, description: '璇存槑' }],
    listLibrary: async () => [{ id: 'fl', name: 'demo', revision: 2, folder: 'test', description: '说明' }],
    describeFlow: async () => ({ alias: 'demo', flowId: 'fl', source: 'latest', revision: 1, currentRevision: 1, drift: false, definition: { flow: { id: 'fl' } } }),
    run: async () => ({ runId: 'run-2', status: 'running' }),
    getRun: async () => run,
    listRuns: async () => [run],
    cancel: async () => ({ runId: 'run-1', status: 'cancelled' }),
    resume: async () => ({ runId: 'run-1', status: 'running' }),
    inbox: async () => [{ id: 'gate-1', kind: 'gate', runId: 'run-1', nodeId: 'approve', whyHuman: '纭' }],
    addRef: async () => ({ flowId: 'fl', name: 'demo', alias: 'demo' }),
    removeRef: async () => ({ flowId: 'fl', alias: 'demo', hadOverride: false }),
    renameRef: async () => ({ flowId: 'fl', alias: 'renamed', revision: null }),
    pinRef: async () => ({ flowId: 'fl', alias: 'demo', revision: 2 }),
    history: async () => ({ flowId: 'fl', alias: 'demo', source: 'latest', currentRevision: 2, pinnedRevision: null, revisions: [{ revision: 2, contentHash: 'sha256:x', snapshotAt: null }, { revision: 1, contentHash: 'sha256:y', snapshotAt: null }] }),
  }
}

const cwdOf = () => '/w'

test('the tool definition exposes only non-publishing actions', () => {
  const tool = createFlowTool({ service: stubService(), cwdOf })
  assert.equal(tool.name, 'hnflow')
  assert.deepEqual(tool.parameters.properties.action.enum, [
    'list_flows',
    'list_library',
    'describe_flow',
    'run',
    'status',
    'list_runs',
    'cancel',
    'resume',
    'inbox',
    'artifact',
    'add_ref',
    'remove_ref',
    'rename_ref',
    'pin',
    'history',
    'triggers',
  ])
})

test('list_flows renders the catalogue', async () => {
  const tool = createFlowTool({ service: stubService(), cwdOf })
  const text = await tool.execute({ action: 'list_flows' }, { agent: { session: { id: 's' } } })
  assert.match(text, /demo/u)
  assert.match(text, /r1 \(follows latest\)/u)
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
  // Unknown actions are rejected by argument validation before the handler.
  await assert.rejects(() => tool2.execute({ action: 'nope' }, {}), /invalid arguments/u)
})

test('formatRun and formatFlows stay compact', () => {
  assert.match(formatRun({ runId: 'r', status: 'failed', error: { code: 'x', message: 'y' }, nodes: [], pending: 0 }), /x: y/u)
  assert.equal(formatFlows([]), 'This workspace references no HNFlow flows.')
  assert.match(formatLibrary([{ id: 'fl', name: 'demo', revision: 2, folder: 'a/b', description: '说明' }]), /demo.*a\/b/u)
})

test('library, reference and history actions render management facts', async () => {
  const tool = createFlowTool({ service: stubService(), cwdOf })
  assert.match(await tool.execute({ action: 'list_library' }, {}), /demo.*r2.*test/u)
  assert.match(await tool.execute({ action: 'add_ref', flow: 'demo', alias: 'd' }, {}), /referenced demo/u)
  assert.match(await tool.execute({ action: 'remove_ref', flow: 'd' }, {}), /removed the reference/u)
  assert.match(await tool.execute({ action: 'rename_ref', flow: 'demo', alias: 'renamed' }, {}), /renamed to renamed/u)
  assert.match(await tool.execute({ action: 'pin', flow: 'demo', revision: 'r2' }, {}), /pinned to r2/u)
  assert.match(await tool.execute({ action: 'history', flow: 'demo' }, {}), /r2.*\[current\]/u)
  assert.match(await tool.execute({ action: 'list_runs' }, {}), /run-1 waiting_human/u)
})

test('project drafts are labelled in the catalogue', () => {
  const text = formatFlows([{ alias: '', flowId: 'fl-local-1', name: '本地流程', local: true, pinnedRevision: null, currentRevision: 0, hasOverride: false, drift: false, missing: false, description: '草稿' }])
  assert.match(text, /本地流程.*local, no revision.*project-draft/u)
})

