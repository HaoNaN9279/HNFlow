/**
 * The node envelope: synthesis, interpretation, and the three-state contract.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { envelopeSchema, judgeEnvelopeSchema, parseEnvelope, parseVerdict } from '../lib/flow/envelope.js'

const output = {
  type: 'object',
  required: ['points'],
  properties: { points: { type: 'array', items: { type: 'string' } } },
  additionalProperties: false,
}

test('the synthesized envelope stays inside the host supported subset', () => {
  const schema = envelopeSchema(output)
  // The host requires an object root and rejects a top-level `oneOf`.
  assert.equal(schema.type, 'object')
  assert.equal(schema.oneOf, undefined)
  assert.deepEqual(schema.properties.status.enum, ['done', 'needs_human', 'failed'])
  const judge = judgeEnvelopeSchema()
  assert.equal(judge.type, 'object')
  assert.equal(judge.properties.output.properties.verdict.enum.length, 3)
})

test('a done envelope carries its output and evidence', () => {
  const parsed = parseEnvelope({ status: 'done', output: { points: ['a'] }, evidence: ['e1', 2], notes: 'n' })
  assert.equal(parsed.kind, 'done')
  assert.deepEqual(parsed.output, { points: ['a'] })
  assert.deepEqual(parsed.evidence, ['e1'])
  assert.equal(parsed.notes, 'n')
})

test('a needs_human envelope carries the gap', () => {
  const parsed = parseEnvelope({
    status: 'needs_human',
    needsHuman: { reason: 'capability_gap', deliverable: { type: 'object' }, whyHuman: '需要手感', blocking: true },
  })
  assert.equal(parsed.kind, 'needs_human')
  assert.equal(parsed.gap.reason, 'capability_gap')
  assert.equal(parsed.gap.blocking, true)
})

test('a failed envelope carries a stable code', () => {
  assert.deepEqual(parseEnvelope({ status: 'failed', error: { code: 'x', message: 'm' } }), { kind: 'failed', error: { code: 'x', message: 'm' } })
  assert.equal(parseEnvelope({ status: 'failed' }).error.code, 'node-failed')
})

test('malformed or absent structured output is invalid, never done', () => {
  assert.equal(parseEnvelope(undefined).kind, 'invalid')
  assert.equal(parseEnvelope({ status: 'done' }).kind, 'invalid')
  assert.equal(parseEnvelope({ status: 'needs_human', needsHuman: {} }).kind, 'invalid')
  assert.equal(parseEnvelope({ status: 'elsewhere' }).kind, 'invalid')
})

test('verdicts are parsed strictly', () => {
  assert.deepEqual(parseVerdict({ verdict: 'accept', reasons: ['ok'] }), { verdict: 'accept', reasons: ['ok'], conditions: [] })
  assert.equal(parseVerdict({ verdict: 'maybe' }), null)
  assert.equal(parseVerdict(null), null)
})
