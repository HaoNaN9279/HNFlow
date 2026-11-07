/**
 * Deliverable requests: asking a human for something the model cannot produce,
 * and refusing to accept it unverified.
 *
 * A request record carries the deliverable schema, the irreplaceability
 * statement and the attempt count. Acceptance is never a boolean the submitter
 * controls: the payload is checked against the schema first, and a judge may
 * add a second opinion, before any downstream node can read it.
 */

import { randomUUID } from 'node:crypto'

import { validateValue } from './flow/schema.js'

/**
 * Build the pending record for a request node.
 * @param {Record<string, any>} node - request node.
 * @param {{now?: Date, gap?: Record<string, any> | null}} [options] - clock and a child's gap declaration.
 * @returns {Record<string, any>} pending record.
 */
export function createRequestPending(node, options = {}) {
  const now = options.now ?? new Date()
  const hours = Number.isFinite(node.deadline?.hours) ? node.deadline.hours : null
  return {
    kind: 'request',
    id: `req-${randomUUID().replace(/-/gu, '').slice(0, 12)}`,
    nodeId: node.id,
    createdAt: now.toISOString(),
    expiresAt: hours === null ? null : new Date(now.getTime() + hours * 3600_000).toISOString(),
    revision: 0,
    attempts: 0,
    whyHuman: String(node.whyHuman ?? ''),
    onExpire: node.onExpire === 'fail' ? 'fail' : 'remind',
    deliverable: node.deliverable ?? { type: 'object' },
    gap: options.gap ?? null,
  }
}

/**
 * Check one submission against a request's deliverable contract.
 * @param {Record<string, any>} pending - request record.
 * @param {unknown} payload - submitted value.
 * @param {{now?: Date, revision?: number}} [options] - clock and current run revision.
 * @returns {{ok: true, delivery: {payload: any, submittedAt: string, violations: []}} | {ok: false, code: string, message: string, violations?: object[]}} result.
 */
export function checkDelivery(pending, payload, options = {}) {
  if (pending?.delivery !== undefined) {
    return { ok: false, code: 'already-decided', message: `request ${pending.id} was already satisfied` }
  }
  if (Number.isInteger(options.revision) && Number.isInteger(pending?.revision) && options.revision !== pending.revision) {
    return { ok: false, code: 'stale-revision', message: `request ${pending.id} expects revision ${pending.revision}, got ${options.revision}` }
  }
  if (payload === undefined || payload === null) {
    return { ok: false, code: 'delivery-empty', message: 'the delivery body is empty' }
  }
  const verdict = validateValue(payload, pending.deliverable)
  if (!verdict.ok) {
    return {
      ok: false,
      code: 'delivery-rejected',
      message: `the delivery does not satisfy the contract (${verdict.violations.length} violation(s))`,
      violations: verdict.violations,
    }
  }
  return {
    ok: true,
    delivery: { payload, submittedAt: (options.now ?? new Date()).toISOString(), violations: [] },
  }
}

/**
 * What happens after a rejected delivery (schema or judge).
 *
 * The attempt budget is per request; running out is an explicit policy
 * (`return` degrades to `fail`), never an infinite loop.
 * @param {Record<string, any>} node - request node.
 * @param {number} attempt - attempts already made (1-based).
 * @returns {'return'|'fallback'|'arbitrate'|'fail'} next step.
 */
export function rejectionStep(node, attempt) {
  const policy = node?.onReject ?? { kind: 'return', maxAttempts: 2 }
  const maxAttempts = Number.isInteger(policy.maxAttempts) && policy.maxAttempts > 0 ? policy.maxAttempts : 2
  if (attempt < maxAttempts) return 'return'
  switch (policy.kind) {
    case 'fallback':
      return 'fallback'
    case 'arbitrate':
      return 'arbitrate'
    case 'return':
    case 'fail':
    default:
      return 'fail'
  }
}
