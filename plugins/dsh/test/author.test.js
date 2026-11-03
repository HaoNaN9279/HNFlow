/**
 * `hnflow_author`: validate and edit inside the workspace, never the asset.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { AUTHOR_ACTIONS, createWorkflowAuthorTool, formatSchema, formatValidation } from '../lib/author.js'

/** A `defineTool` stand-in that keeps the spec addressable. */
const defineTool = (spec) => spec

/**
 * Build the tool over a scripted service.
 * @param {Partial<Record<string, Function>>} overrides - per-method behaviour.
 * @returns {{tool: Record<string, any>, calls: Record<string, any>[]}} tool and call log.
 */
function makeTool(overrides = {}) {
  /** @type {Record<string, any>[]} */
  const calls = []
  const service = {
    schema: async () => ({
      nodeTypes: [
        { type: 'flow:start', category: 'flow', description: 'Entry node' },
        { type: 'data:assign', category: 'data', description: 'Static value' },
      ],
      portTypes: ['data', 'file'],
    }),
    validateDefinition: async (definition) => ({ valid: Array.isArray(definition.nodes) && definition.nodes.length > 0, errors: [] }),
    resolve: async (_cwd, key) => ({ key, definition: { id: 'w', nodes: [{ id: 'start', type: 'flow:start' }], edges: [] } }),
    writeOverride: async (input) => {
      calls.push({ method: 'writeOverride', input })
      return { assetId: 'wf-1', baseRevision: 3, definition: input.definition }
    },
    ...overrides,
  }
  return { tool: createWorkflowAuthorTool({ defineTool, service, cwdOf: () => '/ws' }), calls }
}

const VALID = { id: 'w', name: 'W', nodes: [{ id: 'start', type: 'flow:start' }], edges: [] }

test('the authoring tool exposes no action that writes an asset', () => {
  const { tool } = makeTool()
  assert.equal(tool.name, 'hnflow_author')
  assert.deepEqual(tool.parameters.action.enum, AUTHOR_ACTIONS)
  assert.equal(AUTHOR_ACTIONS.includes('save_asset'), false)
  assert.equal(AUTHOR_ACTIONS.includes('create_asset'), false)
})

test('schema renders categories and port types', async () => {
  const { tool } = makeTool()
  const text = await tool.execute({ action: 'schema' }, {})
  assert.match(text, /node types \(2\)/u)
  assert.match(text, /flow:\n {2}flow:start — Entry node/u)
  assert.match(text, /port types: data, file/u)
})

test('validate reports a valid and an invalid definition', async () => {
  const { tool } = makeTool()
  assert.equal(await tool.execute({ action: 'validate', definition: VALID }, {}), 'definition is valid')

  const invalid = makeTool({ validateDefinition: async () => ({ valid: false, errors: ['nodes must not be empty', 'missing end'] }) })
  const text = await invalid.tool.execute({ action: 'validate', definition: { nodes: [] } }, {})
  assert.match(text, /definition is invalid \(2 problem\(s\)\)/u)
  assert.match(text, /- missing end/u)
})

test('validate requires a definition object', async () => {
  const { tool } = makeTool()
  const text = await tool.execute({ action: 'validate' }, {})
  assert.match(text, /^error definition-required:/u)
})

test('save_override writes the workspace copy and reports the diff', async () => {
  const { tool, calls } = makeTool()
  const changed = { ...VALID, nodes: [...VALID.nodes, { id: 'end', type: 'flow:end' }] }
  const text = await tool.execute({ action: 'save_override', workflow: 'publish', definition: changed, note: 'local tweak' }, {})

  assert.equal(calls.length, 1)
  assert.equal(calls[0].input.cwd, '/ws')
  assert.equal(calls[0].input.key, 'publish')
  assert.equal(calls[0].input.origin, 'agent')
  assert.equal(calls[0].input.note, 'local tweak')
  assert.match(text, /saved the workspace override for publish \(asset wf-1, base r3\)/u)
  assert.match(text, /the asset is unchanged/u)
  assert.match(text, /nodes\.1/u)
})

test('an invalid definition is not written', async () => {
  const { tool, calls } = makeTool({ validateDefinition: async () => ({ valid: false, errors: ['dangling edge'] }) })
  const text = await tool.execute({ action: 'save_override', workflow: 'publish', definition: { nodes: [] } }, {})

  assert.equal(calls.length, 0)
  assert.match(text, /^nothing written/u)
  assert.match(text, /dangling edge/u)
})

test('save_override needs a workflow name and a workspace', async () => {
  const missingName = await makeTool().tool.execute({ action: 'save_override', definition: VALID }, {})
  assert.match(missingName, /^error workflow-required:/u)

  const noWorkspace = createWorkflowAuthorTool({ defineTool, service: makeTool().tool.service ?? {}, cwdOf: () => null })
  const text = await noWorkspace.execute({ action: 'validate', definition: VALID }, {})
  assert.match(text, /^error workspace-unavailable:/u)
})

test('format helpers are stable', () => {
  assert.equal(formatValidation({ valid: true, errors: [] }), 'definition is valid')
  assert.match(formatSchema({ nodeTypes: [], portTypes: [] }), /node types \(0\)/u)
})
