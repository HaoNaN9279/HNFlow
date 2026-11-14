/**
 * The `hnflow_author` tool: schema, validation and project-local flow files.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { FLOW_SCHEMA_REFERENCE, createAuthorTool } from '../lib/author.js'

const cwdOf = () => '/w'

const validFlow = {
  schemaVersion: 2,
  flow: { id: 'fl-a', name: 'a' },
  input: { type: 'object', properties: {} },
  nodes: [{ id: 'n', type: 'agent', preset: 'hnflow', instruction: 'x', output: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } }],
  edges: [],
}

/**
 * A service stub that validates real definitions and records drafts.
 * @returns {Record<string, any>} service.
 */
function stubService() {
  const calls = []
  return {
    calls,
    validate: async () => ({ ok: true, errors: [], warnings: [] }),
    describeFlow: async () => ({ flowId: 'fl-a', flowName: 'a', definition: validFlow, currentRevision: 1 }),
    draft: async (input) => {
      calls.push(input)
      return { draft: true, local: true, flowId: 'fl-a', group: 'local', path: '/w/.hnflow/groups/local/flows/fl-a.flow.json', validation: { ok: true, errors: [] }, next: 'the project-local flow file was updated' }
    },
    createFlow: async (input) => {
      calls.push(input)
      return { scope: 'project', key: 'local/fl-new', flowId: 'fl-new', name: input.name ?? 'new', group: input.folder || 'local', local: true, path: '/w/.hnflow/groups/local/flows/fl-new.flow.json', validation: { ok: true, errors: [] } }
    },
    deleteLocal: async (input) => {
      calls.push(input)
      return { key: 'local/fl-local', flowId: 'fl-local', name: 'new', group: 'local', local: true }
    },
    renameLocal: async (input) => {
      calls.push(input)
      return { key: 'local/fl-local', flowId: 'fl-local', name: input.name, group: 'local', local: true }
    },
  }
}

test('the schema action documents the six primitives and no publish', async () => {
  const tool = createAuthorTool({ service: stubService(), cwdOf })
  const text = await tool.execute({ action: 'schema' }, {})
  const reference = JSON.parse(text)
  assert.deepEqual(reference.notes.nodeTypes, ['agent', 'judge', 'merge', 'gate', 'request', 'verify'])
  assert.equal(reference.notes.publish, undefined)
  assert.match(reference.notes.workflow, /依赖组/u)
  assert.equal(FLOW_SCHEMA_REFERENCE.schemaVersion, 2)
})

test('validate reports definition problems before touching the service', async () => {
  const tool = createAuthorTool({ service: stubService(), cwdOf })
  const text = await tool.execute({ action: 'validate', definition: { nodes: [] } }, {})
  const result = JSON.parse(text)
  assert.equal(result.ok, false)
  assert.equal(result.errors[0].code, 'definition-invalid')
})

test('validate accepts a definition object and delegates host checks', async () => {
  const tool = createAuthorTool({ service: stubService(), cwdOf })
  const result = JSON.parse(await tool.execute({ action: 'validate', definition: validFlow }, {}))
  assert.equal(result.ok, true)
})

test('draft updates a project-local flow file', async () => {
  const service = stubService()
  const tool = createAuthorTool({ service, cwdOf })
  const result = JSON.parse(await tool.execute({ action: 'draft', flow: 'a', definition: validFlow, note: 'first pass' }, {}))
  assert.equal(result.ok, true)
  assert.equal(service.calls.length, 1)
  assert.equal(service.calls[0].note, 'first pass')
  assert.match(result.next, /project-local flow file/u)
})

test('there is no publish action', async () => {
  const tool = createAuthorTool({ service: stubService(), cwdOf })
  await assert.rejects(() => tool.execute({ action: 'publish' }, {}), /invalid arguments/u)
  assert.equal(tool.parameters.properties.action.enum.includes('publish'), false)
})

test('create writes a flow into a project-local capability group', async () => {
  const service = stubService()
  const tool = createAuthorTool({ service, cwdOf })
  const project = JSON.parse(await tool.execute({ action: 'create', definition: validFlow, name: '新流程', folder: 'team' }, {}))
  assert.equal(project.created, true)
  assert.equal(project.scope, 'project')
  assert.equal(service.calls[0].folder, 'team')
  assert.equal(service.calls[0].scope, undefined)
})

test('delete and rename manage project-local flows only', async () => {
  const service = stubService()
  const tool = createAuthorTool({ service, cwdOf })
  const deleted = JSON.parse(await tool.execute({ action: 'delete', flow: 'local' }, {}))
  assert.equal(deleted.deleted, true)
  const renamed = JSON.parse(await tool.execute({ action: 'rename', flow: 'local', name: '改名' }, {}))
  assert.equal(renamed.name, '改名')
  assert.equal(tool.parameters.properties.action.enum.includes('promote'), false)
  assert.equal(tool.parameters.properties.action.enum.includes('publish'), false)
})

