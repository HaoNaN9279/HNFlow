/**
 * Publish-time static validation: one reverse case per failure code.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { validateFlow } from '../lib/flow/validate.js'
import { gateFlow } from './helpers.js'

/**
 * Run validation and return the error codes.
 * @param {Record<string, any>} definition - flow.
 * @param {Record<string, any>} [options] - host facts.
 * @returns {Promise<string[]>} codes.
 */
async function codes(definition, options = {}) {
  const result = await validateFlow(definition, options)
  return result.errors.map((error) => error.code)
}

/**
 * Clone a flow.
 * @param {Record<string, any>} flow - source.
 * @returns {Record<string, any>} deep copy.
 */
function clone(flow) {
  return JSON.parse(JSON.stringify(flow))
}

test('a minimal agent → gate flow passes', async () => {
  const result = await validateFlow(gateFlow(), { checkPreset: async () => ({ ok: true }) })
  assert.deepEqual(result.errors, [])
  assert.equal(result.ok, true)
})

test('unsupported schema keywords are rejected', async () => {
  const flow = clone(gateFlow())
  flow.nodes[0].output = { type: 'object', properties: { points: { type: 'array', items: { type: 'string', format: 'uri' } } } }
  assert.ok((await codes(flow)).includes('schema-unsupported'))
})

test('a downstream contract the producer cannot satisfy is rejected', async () => {
  const flow = clone(gateFlow())
  flow.nodes.splice(1, 0, {
    id: 'consume',
    type: 'agent',
    preset: 'standard',
    instruction: 'consume',
    input: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
    output: { type: 'object' },
  })
  flow.edges = [
    { id: 'e1', from: 'draft', to: 'consume', when: { kind: 'status', is: 'done' } },
    { id: 'e2', from: 'consume', to: 'approve', when: { kind: 'status', is: 'done' } },
  ]
  const found = await codes(flow)
  assert.ok(found.includes('contract-unsatisfiable'), found.join(','))
})

test('an unbound required input is rejected', async () => {
  const flow = clone(gateFlow())
  flow.nodes[1].type = 'agent'
  flow.nodes[1].preset = 'hnflow'
  flow.nodes[1].instruction = 'more'
  flow.nodes[1].input = { type: 'object', required: ['brief'], properties: { brief: { type: 'string' } } }
  flow.nodes[1].output = { type: 'object' }
  flow.edges = [{ id: 'e1', from: 'draft', to: 'approve', when: { kind: 'status', is: 'done' } }]
  // draft's output is `{points}`, so `brief` has no source.
  assert.ok((await codes(flow)).includes('input-unbound'))
})

test('a gate with edges must route all three outcomes', async () => {
  const flow = clone(gateFlow())
  flow.nodes.push({ id: 'after', type: 'agent', preset: 'hnflow', instruction: 'after', output: { type: 'object' } })
  flow.edges = [
    { id: 'e1', from: 'draft', to: 'approve', when: { kind: 'status', is: 'done' } },
    { id: 'e2', from: 'approve', to: 'after', when: { kind: 'gate', is: 'approved' } },
  ]
  const found = await codes(flow)
  assert.ok(found.includes('gate-branches-incomplete'), found.join(','))
})

test('a judge cannot reuse its producer preset', async () => {
  const flow = clone(gateFlow())
  flow.nodes[1] = { id: 'verdict', type: 'judge', preset: 'hnflow', instruction: 'judge', criteria: 'check' }
  flow.edges = [{ id: 'e1', from: 'draft', to: 'verdict', when: { kind: 'status', is: 'done' } }]
  assert.ok((await codes(flow)).includes('judge-same-as-producer'))
})

test('presets outside the allowlist are rejected', async () => {
  const flow = clone(gateFlow())
  flow.nodes[0].preset = 'rogue'
  assert.ok((await codes(flow)).includes('preset-not-allowed'))
})

test('an unknown preset is reported by the host check', async () => {
  const flow = clone(gateFlow())
  const found = await codes(flow, { checkPreset: async () => ({ ok: false, code: 'preset-unknown' }) })
  assert.ok(found.includes('preset-unknown'))
})

test('model layers are checked only when a node names one', async () => {
  const flow = clone(gateFlow())
  flow.nodes[0].model = 'strong'
  assert.ok((await codes(flow, { checkLayer: async () => ({ ok: false, code: 'model-layer-unknown' }) })).includes('model-layer-unknown'))
  const unavailable = await codes(flow, { vibestackAvailable: false })
  assert.ok(unavailable.includes('vibestack-unavailable'))
})

test('a request needs a deliverable and whyHuman', async () => {
  const flow = {
    schemaVersion: 2,
    flow: { id: 'fl-r', name: 'r' },
    input: { type: 'object', properties: {} },
    nodes: [{ id: 'art', type: 'request' }],
    edges: [],
  }
  const found = await codes(flow)
  assert.ok(found.includes('request-contract-missing'))
})

test('cycles, multiple starts and invalid ids are rejected', async () => {
  const cyclic = clone(gateFlow())
  cyclic.nodes[1].type = 'agent'
  cyclic.nodes[1].preset = 'hnflow'
  cyclic.nodes[1].instruction = 'x'
  cyclic.nodes[1].output = { type: 'object' }
  cyclic.edges = [
    { id: 'e1', from: 'draft', to: 'approve', when: { kind: 'status', is: 'done' } },
    { id: 'e2', from: 'approve', to: 'draft', when: { kind: 'status', is: 'done' } },
  ]
  const found = await codes(cyclic)
  assert.ok(found.includes('cycle-unsupported'))

  const twoStarts = clone(gateFlow())
  twoStarts.nodes.push({ id: 'other', type: 'agent', preset: 'hnflow', instruction: 'x', output: { type: 'object' } })
  twoStarts.edges.push({ id: 'e2', from: 'other', to: 'approve', when: { kind: 'status', is: 'done' } })
  assert.ok((await codes(twoStarts)).includes('graph-shape-invalid'))

  const badId = clone(gateFlow())
  badId.nodes[0].id = '../escape'
  assert.ok((await codes(badId)).includes('node-id-invalid'))
})

test('a human delivery flow validates end to end', async () => {
  const flow = {
    schemaVersion: 2,
    flow: { id: 'fl-d', name: 'd' },
    input: { type: 'object', properties: {} },
    nodes: [
      {
        id: 'art',
        type: 'request',
        deliverable: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
        whyHuman: '需要人',
      },
      { id: 'accept', type: 'verify', against: 'art', checks: ['schema', 'judge'], judge: { preset: 'standard', criteria: '像样' }, onReject: { kind: 'return', maxAttempts: 2 } },
      {
        id: 'integrate',
        type: 'agent',
        preset: 'hnflow',
        instruction: '接入',
        input: { type: 'object', properties: { artifact: { type: 'object' } } },
        output: { type: 'object', required: ['changes'], properties: { changes: { type: 'array' } }, additionalProperties: false },
      },
    ],
    edges: [
      { id: 'e1', from: 'art', to: 'accept', when: { kind: 'status', is: 'done' } },
      { id: 'e2', from: 'accept', to: 'integrate', when: { kind: 'status', is: 'done' } },
    ],
  }
  const result = await validateFlow(flow)
  assert.deepEqual(result.errors, [])
})
