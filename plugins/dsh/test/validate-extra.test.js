/**
 * The validation additions that close §4.6 gaps: merge maps, expiry policies,
 * rejection policies and inconclusive routing declarations.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { validateFlow } from '../lib/flow/validate.js'

/**
 * A flow whose merge has a map, with one request to hang policies on.
 * @param {Record<string, any>} [overrides] - per-node overrides by id.
 * @returns {Record<string, any>} definition.
 */
function flowWith(overrides = {}) {
  return {
    schemaVersion: 2,
    flow: { id: 'fl-v', name: '校验' },
    input: { type: 'object', properties: {}, additionalProperties: true },
    nodes: [
      { id: 'a', type: 'agent', preset: 'hnflow', instruction: 'a', output: { type: 'object', properties: { x: { type: 'string' } }, additionalProperties: false } },
      { id: 'b', type: 'agent', preset: 'hnflow', instruction: 'b', output: { type: 'object', properties: { y: { type: 'string' } }, additionalProperties: false } },
      { id: 'm', type: 'merge', from: ['a', 'b'], map: { x: 'a.x', y: 'b.y' }, output: { type: 'object', properties: { x: { type: 'string' }, y: { type: 'string' } }, additionalProperties: false } },
      { id: 'ask', type: 'request', deliverable: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } } }, whyHuman: '需要文件' },
      ...(overrides.extra ?? []),
    ].map((node) => (overrides[node.id] === undefined ? node : { ...node, ...overrides[node.id] })),
    edges: [
      { id: 'e1', from: 'a', to: 'b', when: { kind: 'status', is: 'done' } },
      { id: 'e2', from: 'b', to: 'm', when: { kind: 'status', is: 'done' } },
      { id: 'e3', from: 'm', to: 'ask', when: { kind: 'status', is: 'done' } },
    ],
  }
}

/**
 * Run validation and return the error codes.
 * @param {Record<string, any>} definition - flow.
 * @returns {Promise<string[]>} codes.
 */
async function codes(definition) {
  const result = await validateFlow(definition, { vibeStackAvailable: true })
  return result.errors.map((entry) => entry.code)
}

test('a merge map may only read its declared sources', async () => {
  assert.deepEqual(await codes(flowWith()), [])
  assert.deepEqual(await codes(flowWith({ m: { map: { x: 'zzz.x' } } })), ['merge-map-invalid'])
  assert.deepEqual(await codes(flowWith({ m: { map: { x: 'a..x' } } })), ['merge-map-invalid'])
  assert.deepEqual(await codes(flowWith({ m: { map: [] } })), ['merge-map-invalid'])
  assert.deepEqual(await codes(flowWith({ m: { map: { x: 'b.y' } } })), [])
})

test('gate and request deadlines and expiry policies are validated', async () => {
  const gate = { id: 'g', type: 'gate' }
  const base = flowWith({ extra: [gate] })
  base.edges.push({ id: 'e4', from: 'ask', to: 'g', when: { kind: 'status', is: 'done' } })
  assert.deepEqual(await codes(base), [])

  const bad = flowWith({ extra: [{ id: 'g', type: 'gate', deadline: { hours: 0 }, onExpire: 'explode' }] })
  bad.edges.push({ id: 'e4', from: 'ask', to: 'g', when: { kind: 'status', is: 'done' } })
  const found = await codes(bad)
  assert.equal(found.filter((code) => code === 'definition-invalid').length >= 2, true)
})

test('rejection policies are validated instead of failing at run time', async () => {
  assert.deepEqual(await codes(flowWith({ ask: { onReject: { kind: 'return', maxAttempts: 2 } } })), [])
  assert.deepEqual(await codes(flowWith({ ask: { onReject: { kind: 'retry' } } })), ['reject-policy-invalid'])
  assert.deepEqual(await codes(flowWith({ ask: { onReject: { kind: 'return', maxAttempts: 0 } } })), ['reject-policy-invalid'])
  assert.deepEqual(await codes(flowWith({ ask: { onReject: { kind: 'arbitrate', judge: { preset: '' } } } })), ['reject-policy-invalid'])
})

test('verify declares how an inconclusive judge is routed', async () => {
  const withVerify = (verify) => {
    const definition = flowWith({ extra: [verify] })
    definition.edges.push({ id: 'e4', from: 'ask', to: 'v', when: { kind: 'status', is: 'done' } })
    return definition
  }
  assert.deepEqual(await codes(withVerify({ id: 'v', type: 'verify', against: 'ask' })), [])
  assert.deepEqual(await codes(withVerify({ id: 'v', type: 'verify', against: 'ask', onInconclusive: 'gate' })), [])
  assert.deepEqual(await codes(withVerify({ id: 'v', type: 'verify', against: 'ask', onInconclusive: 'ignore' })), ['definition-invalid'])
})
