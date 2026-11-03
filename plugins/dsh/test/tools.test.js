/**
 * The `hnflow` tool: explicit naming, readable failures, wait semantics.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_RUN_WAIT_SECONDS, MAX_RUN_WAIT_SECONDS, clampWait, createWorkflowTool, formatRunStatus, formatWorkflowList } from '../lib/tools.js'

/** A `defineTool` stand-in that keeps the spec addressable. */
const defineTool = (spec) => spec

/**
 * A service stand-in with scripted responses.
 * @param {Partial<Record<string, Function>>} overrides - per-method behaviour.
 * @returns {Record<string, any>} fake service.
 */
function fakeService(overrides = {}) {
  return {
    listWorkflows: async () => [
      { alias: 'publish', assetId: 'wf-1', description: '发布流程', pinnedRevision: 3, currentRevision: 4, hasOverride: true, drift: true, enabled: true, missing: false },
      { alias: '', assetId: 'wf-2', description: '', pinnedRevision: null, currentRevision: 1, hasOverride: false, drift: false, enabled: true, missing: false },
    ],
    resolve: async (_cwd, key) => ({ key, alias: key, assetId: 'wf-1', assetName: '发布流程', definition: { nodes: [] }, source: 'ref', revision: 3, currentRevision: 4, drift: true }),
    startRun: async () => ({ runId: 'run-1', status: 'queued', startedAt: 'now', resolved: { source: 'ref', revision: 3 } }),
    status: async () => ({ runId: 'run-1', status: 'succeeded', error: null, nodes: [{ nodeId: 'greet', status: 'succeeded' }], result: { in: 'hello' } }),
    waitFor: async () => ({ runId: 'run-1', status: 'succeeded', error: null, nodes: [], result: { in: 'hello' } }),
    cancel: async () => ({ runId: 'run-1', status: 'running', cancelled: true }),
    listAssets: async () => [{ id: 'wf-1', name: '发布流程', revision: 4, description: '发布' }],
    ...overrides,
  }
}

/**
 * Build the tool over a fake service.
 * @param {Record<string, any>} service - fake service.
 * @returns {Record<string, any>} tool definition.
 */
function makeTool(service) {
  return createWorkflowTool({ defineTool, service, cwdOf: () => '/ws' })
}

test('the tool name avoids the built-in workflow tool', () => {
  const tool = makeTool(fakeService())
  assert.equal(tool.name, 'hnflow')
  assert.equal(tool.parameters.action.enum.includes('run'), true)
})

test('list renders alias, revision, and flags', async () => {
  const text = await makeTool(fakeService()).execute({ action: 'list' }, {})
  assert.match(text, /- publish \(wf-1, pinned r3 of r4\) \[override, drift\]: 发布流程/u)
  assert.match(text, /- wf-2 \(wf-2, r1\)/u)
})

test('run requires an explicit workflow name', async () => {
  const text = await makeTool(fakeService()).execute({ action: 'run' }, {})
  assert.match(text, /^error workflow-required:/u)
})

test('run reports provenance and the terminal status', async () => {
  const text = await makeTool(fakeService()).execute({ action: 'run', workflow: 'publish', input: { target: 'staging' } }, {})
  assert.match(text, /^started run-1 from ref r3/u)
  assert.match(text, /run run-1: succeeded/u)
  assert.match(text, /result: \{"in":"hello"\}/u)
})

test('run honours wait_seconds=0 by sampling once', async () => {
  let waited = false
  const service = fakeService({
    waitFor: async () => {
      waited = true
      return { runId: 'run-1', status: 'succeeded' }
    },
  })
  const text = await makeTool(service).execute({ action: 'run', workflow: 'publish', wait_seconds: 0 }, {})
  assert.equal(waited, false)
  assert.match(text, /run run-1: succeeded/u)
})

test('service failures surface as coded text, not exceptions', async () => {
  const service = fakeService({
    resolve: async () => {
      const error = new Error('no workflow named publish in this workspace')
      error.code = 'ref-missing'
      throw error
    },
  })
  const text = await makeTool(service).execute({ action: 'get', workflow: 'publish' }, {})
  assert.equal(text, 'error ref-missing: no workflow named publish in this workspace')
})

test('a session without a workspace says so', async () => {
  const tool = createWorkflowTool({ defineTool, service: fakeService(), cwdOf: () => null })
  assert.match(await tool.execute({ action: 'list' }, {}), /workspace-unavailable/u)
})

test('wait budgets clamp to the documented bounds', () => {
  assert.equal(clampWait(undefined), DEFAULT_RUN_WAIT_SECONDS)
  assert.equal(clampWait(-5), 0)
  assert.equal(clampWait(10_000), MAX_RUN_WAIT_SECONDS)
  assert.equal(clampWait(Number.NaN), DEFAULT_RUN_WAIT_SECONDS)
})

test('run status text omits empty sections', () => {
  assert.equal(formatRunStatus({ runId: 'run-1', status: 'failed', error: 'boom', nodes: [], result: null }), 'run run-1: failed\nerror: boom')
})

test('an empty catalogue has a usable message', () => {
  assert.equal(formatWorkflowList([]), 'This workspace references no HNFlow workflows.')
})
