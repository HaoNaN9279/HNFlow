/**
 * The `hnflow_author` tool: schema, validation and drafting (never publishing).
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
      return { draft: true, flowId: 'fl-a', baseRevision: 1, updatedAt: 'now', validation: { ok: true, errors: [] }, next: 'a human must publish it (/hnflow publish <flow>) before it becomes a revision' }
    },
    createFlow: async (input) => {
      calls.push(input)
      return { scope: input.scope ?? 'project', flowId: 'fl-new', name: input.name ?? 'new', folder: input.folder ?? '', local: input.scope !== 'library', validation: { ok: true, errors: [] } }
    },
    promote: async (input) => {
      calls.push(input)
      return { scope: 'library', flowId: 'fl-promoted', previousFlowId: 'fl-local', name: 'new', folder: input.folder ?? '' }
    },
    deleteLocal: async (input) => {
      calls.push(input)
      return { flowId: 'fl-local', name: 'new', local: true }
    },
    renameLocal: async (input) => {
      calls.push(input)
      return { flowId: 'fl-local', name: input.name, local: true }
    },
  }
}

test('the schema action documents the six primitives and no publish', async () => {
  const tool = createAuthorTool({ service: stubService(), cwdOf })
  const text = await tool.execute({ action: 'schema' }, {})
  const reference = JSON.parse(text)
  assert.deepEqual(reference.notes.nodeTypes, ['agent', 'judge', 'merge', 'gate', 'request', 'verify'])
  assert.equal(reference.notes.publish.includes('\u4e0d\u53ef\u7531\u5de5\u5177\u8c03\u7528'), true)
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

test('draft writes an agent override with the note', async () => {
  const service = stubService()
  const tool = createAuthorTool({ service, cwdOf })
  const result = JSON.parse(await tool.execute({ action: 'draft', flow: 'a', definition: validFlow, note: 'first pass' }, {}))
  assert.equal(result.ok, true)
  assert.equal(service.calls.length, 1)
  assert.equal(service.calls[0].note, 'first pass')
  assert.match(result.next, /human must publish/u)
})

test('there is no publish action', async () => {
  const tool = createAuthorTool({ service: stubService(), cwdOf })
  await assert.rejects(() => tool.execute({ action: 'publish' }, {}), /invalid arguments/u)
  assert.equal(tool.parameters.properties.action.enum.includes('publish'), false)
})

test('create defaults to a project draft and can target the library', async () => {
  const service = stubService()
  const tool = createAuthorTool({ service, cwdOf })
  const project = JSON.parse(await tool.execute({ action: 'create', definition: validFlow, name: '新流程' }, {}))
  assert.equal(project.created, true)
  assert.equal(project.scope, 'project')
  assert.equal(service.calls[0].scope, 'project')
  const library = JSON.parse(await tool.execute({ action: 'create', definition: validFlow, name: '通用流程', scope: 'library', folder: 'a/b' }, {}))
  assert.equal(library.scope, 'library')
  assert.equal(service.calls[1].folder, 'a/b')
  assert.equal(service.calls[1].reference, true)
})

test('promote, delete and rename are explicit draft management actions', async () => {
  const service = stubService()
  const tool = createAuthorTool({ service, cwdOf })
  const promoted = JSON.parse(await tool.execute({ action: 'promote', flow: 'local', folder: 'team' }, {}))
  assert.equal(promoted.promoted, true)
  assert.equal(service.calls[0].folder, 'team')
  const deleted = JSON.parse(await tool.execute({ action: 'delete', flow: 'local' }, {}))
  assert.equal(deleted.deleted, true)
  const renamed = JSON.parse(await tool.execute({ action: 'rename', flow: 'local', name: '改名' }, {}))
  assert.equal(renamed.name, '改名')
  assert.equal(tool.parameters.properties.action.enum.includes('publish'), false)
})

