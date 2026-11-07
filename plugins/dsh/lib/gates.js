/**
 * Gate records: the plugin-owned half of a human decision.
 *
 * A gate is written to storage before anyone is asked, and every submission is
 * compare-and-set on the run revision. That is what makes the card and the page
 * two views of one decision rather than two competing sources.
 */

import { randomUUID } from 'node:crypto'

import { GATE_DECISIONS } from './flow/definition.js'

/**
 * Build the pending record for a gate node.
 * @param {Record<string, any>} node - gate node.
 * @param {{now?: Date, snapshot?: Record<string, any>}} [options] - clock and snapshot.
 * @returns {Record<string, any>} pending record.
 */
export function createGatePending(node, options = {}) {
  const now = options.now ?? new Date()
  const deadline = Number.isFinite(node.deadline?.hours) ? now.getTime() + node.deadline.hours * 3600_000 : null
  return {
    kind: 'gate',
    id: `gate-${randomUUID().replace(/-/gu, '').slice(0, 12)}`,
    nodeId: node.id,
    createdAt: now.toISOString(),
    expiresAt: deadline === null ? null : new Date(deadline).toISOString(),
    revision: 0,
    options: Array.isArray(node.options) ? node.options.filter((option) => typeof option === 'string') : [],
    snapshot: options.snapshot ?? {},
  }
}

/**
 * Apply one decision to a pending gate.
 * @param {Record<string, any>} pending - pending record.
 * @param {{decision?: unknown, reason?: unknown, revision?: unknown}} input - submission.
 * @param {{now?: Date, runRevision?: number}} [options] - clock and current run revision.
 * @returns {{ok: true, decision: {decision: string, reason: string, decidedAt: string}} | {ok: false, code: string, message: string}} result.
 */
export function decideGate(pending, input, options = {}) {
  if (pending?.decision !== undefined) {
    return { ok: false, code: 'already-decided', message: `gate ${pending.id} was already decided` }
  }
  const expected = Number.isInteger(options.runRevision) ? options.runRevision : pending?.revision
  if (Number.isInteger(input?.revision) && Number.isInteger(expected) && input.revision !== expected) {
    return { ok: false, code: 'stale-revision', message: `gate ${pending.id} expects revision ${expected}, got ${input.revision}` }
  }
  const decision = typeof input?.decision === 'string' ? input.decision : ''
  if (!GATE_DECISIONS.includes(decision)) {
    return { ok: false, code: 'invalid-decision', message: `decision must be one of ${GATE_DECISIONS.join(', ')}` }
  }
  const reason = typeof input?.reason === 'string' ? input.reason.trim().slice(0, 2000) : ''
  if (decision === 'rejected' && reason.length === 0) {
    return { ok: false, code: 'reason-required', message: 'a rejection needs a reason' }
  }
  return {
    ok: true,
    decision: { decision, reason, decidedAt: (options.now ?? new Date()).toISOString() },
  }
}

/**
 * The question card for a gate.
 * @param {Record<string, any>} node - gate node.
 * @param {Record<string, any>} pending - pending record.
 * @returns {{id: string, header: string, question: string, detail: string, options: {label: string, description?: string}[]}} question.
 */
export function gateQuestion(node, pending) {
  const extra = Array.isArray(pending.options) ? pending.options : []
  const detail = typeof node.detail === 'string' && node.detail.length > 0 ? node.detail : ''
  return {
    id: pending.id,
    header: typeof node.title === 'string' && node.title.length > 0 ? node.title.slice(0, 60) : `门禁 ${node.id}`,
    question: detail.length > 0 ? detail : `流程在节点 ${node.id} 等待你的裁决。`,
    detail: JSON.stringify(pending.snapshot ?? {}, null, 2).slice(0, 4000),
    options: [
      { label: 'approve', description: '批准并继续' },
      { label: 'reject', description: '拒绝并走失败分支' },
      { label: 'modify', description: '修改后批准（在理由里写明修改）' },
      ...extra.map((label) => ({ label })),
    ],
  }
}
