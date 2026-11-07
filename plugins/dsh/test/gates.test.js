/**
 * Gates and deliverable requests: CAS, validation, and rejection budgets.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createGatePending, decideGate, gateQuestion } from '../lib/gates.js'
import { checkDelivery, createRequestPending, rejectionStep } from '../lib/requests.js'

const now = new Date('2026-11-07T00:00:00.000Z')

test('a gate record carries its options, snapshot and expiry', () => {
  const pending = createGatePending({ id: 'g', title: 't', options: ['通过', '重做'], deadline: { hours: 2 } }, { now, snapshot: { a: 1 } })
  assert.equal(pending.kind, 'gate')
  assert.deepEqual(pending.options, ['通过', '重做'])
  assert.deepEqual(pending.snapshot, { a: 1 })
  assert.equal(pending.expiresAt, '2026-11-07T02:00:00.000Z')
})

test('a gate decision is validated and compare-and-set', () => {
  const pending = createGatePending({ id: 'g' }, { now })
  assert.equal(decideGate(pending, { decision: 'maybe' }).code, 'invalid-decision')
  assert.equal(decideGate(pending, { decision: 'rejected', reason: '' }).code, 'reason-required')
  const stale = decideGate(pending, { decision: 'approved', revision: 3 }, { runRevision: 4 })
  assert.equal(stale.code, 'stale-revision')
  const ok = decideGate(pending, { decision: 'approved', revision: 4 }, { runRevision: 4, now })
  assert.equal(ok.ok, true)
  assert.equal(ok.decision.decision, 'approved')
  pending.decision = ok.decision
  assert.equal(decideGate(pending, { decision: 'approved' }).code, 'already-decided')
})

test('the gate card offers all three outcomes plus the author options', () => {
  const pending = createGatePending({ id: 'g', title: '定稿', detail: '确认方向', options: ['重做'] }, { now })
  const question = gateQuestion({ id: 'g', title: '定稿', detail: '确认方向' }, pending)
  assert.equal(question.header, '定稿')
  assert.deepEqual(question.options.map((option) => option.label), ['approve', 'reject', 'modify', '重做'])
})

test('a delivery must satisfy the deliverable schema', () => {
  const pending = createRequestPending(
    {
      id: 'r',
      deliverable: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
      whyHuman: '需要人',
    },
    { now },
  )
  assert.equal(checkDelivery(pending, {}).code, 'delivery-rejected')
  const bad = checkDelivery(pending, { files: 'a' })
  assert.equal(bad.code, 'delivery-rejected')
  assert.equal(bad.violations.length, 1)
  const ok = checkDelivery(pending, { files: ['a.png'] }, { now })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.delivery.payload, { files: ['a.png'] })
  assert.equal(checkDelivery({ ...pending, delivery: ok.delivery }, { files: [] }).code, 'already-decided')
  assert.equal(checkDelivery(pending, undefined).code, 'delivery-empty')
})

test('a stale delivery revision is rejected', () => {
  const pending = { ...createRequestPending({ id: 'r', deliverable: { type: 'object' } }, { now }), revision: 2 }
  assert.equal(checkDelivery(pending, {}, { revision: 1 }).code, 'stale-revision')
})

test('rejection budgets end in an explicit policy', () => {
  const node = { onReject: { kind: 'return', maxAttempts: 2 } }
  assert.equal(rejectionStep(node, 1), 'return')
  assert.equal(rejectionStep(node, 2), 'fail')
  assert.equal(rejectionStep({ onReject: { kind: 'fallback', maxAttempts: 1 } }, 1), 'fallback')
  assert.equal(rejectionStep({ onReject: { kind: 'arbitrate', maxAttempts: 1 } }, 1), 'arbitrate')
  assert.equal(rejectionStep({}, 5), 'fail')
})
