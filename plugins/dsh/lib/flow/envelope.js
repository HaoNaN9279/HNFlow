/**
 * The node envelope: the only contract between the plugin and a subagent.
 *
 * A child may only declare one of three structured intents — it finished, it
 * needs a human, or it failed. Whether a declaration counts as done, and what
 * may consume it, is decided by the plugin's own state machine, never by the
 * generator's self-report.
 */

import { VERDICT_SCHEMA } from './definition.js'

/**
 * Wrap a node's output schema in the three-state envelope.
 * @param {Record<string, any>} outputSchema - the node's own `output` schema.
 * @returns {Record<string, any>} envelope schema for `outputSchema`.
 */
export function envelopeSchema(outputSchema) {
  // The host's structured-output validator is object-rooted and rejects a
  // top-level `oneOf`, so the three intents share one flat object. `status`
  // selects the intent; `parseEnvelope` enforces the per-intent fields.
  return {
    type: 'object',
    required: ['status'],
    properties: {
      status: { type: 'string', enum: ['done', 'needs_human', 'failed'] },
      output: outputSchema,
      evidence: { type: 'array', items: { type: 'string' } },
      notes: { type: 'string' },
      needsHuman: {
        type: 'object',
        required: ['reason', 'deliverable', 'whyHuman'],
        properties: {
          reason: {
            type: 'string',
            enum: ['capability_gap', 'real_world_judgement', 'authority', 'ambiguous_intent', 'asset_unavailable'],
          },
          deliverable: { type: 'object' },
          whyHuman: { type: 'string' },
          blocking: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      error: {
        type: 'object',
        properties: { code: { type: 'string' }, message: { type: 'string' } },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  }
}

/**
 * The envelope a judge child returns: the same three states, with the verdict
 * as its output schema.
 * @returns {Record<string, any>} envelope schema.
 */
export function judgeEnvelopeSchema() {
  return envelopeSchema(VERDICT_SCHEMA)
}

/**
 * Interpret a child's structured result.
 *
 * An absent or malformed structure is `invalid`, never `done`: the plugin does
 * not promote a narrative answer into a completion claim.
 * @param {unknown} structured - `result.structured`.
 * @returns {{kind: 'done', output: any, evidence: string[], notes: string}
 *   | {kind: 'needs_human', gap: {reason: string, deliverable: Record<string, any>, whyHuman: string, blocking: boolean}}
 *   | {kind: 'failed', error: {code: string, message: string}}
 *   | {kind: 'invalid', message: string}} parsed envelope.
 */
export function parseEnvelope(structured) {
  if (structured === null || typeof structured !== 'object' || Array.isArray(structured)) {
    return { kind: 'invalid', message: 'the child returned no structured envelope' }
  }
  const value = /** @type {Record<string, any>} */ (structured)
  switch (value.status) {
    case 'done':
      if (value.output === undefined) return { kind: 'invalid', message: 'status "done" without output' }
      return {
        kind: 'done',
        output: value.output,
        evidence: Array.isArray(value.evidence) ? value.evidence.filter((entry) => typeof entry === 'string') : [],
        notes: typeof value.notes === 'string' ? value.notes : '',
      }
    case 'needs_human': {
      const gap = value.needsHuman
      if (gap === null || typeof gap !== 'object') return { kind: 'invalid', message: 'status "needs_human" without needsHuman' }
      if (typeof gap.reason !== 'string' || typeof gap.whyHuman !== 'string' || gap.deliverable === null || typeof gap.deliverable !== 'object') {
        return { kind: 'invalid', message: 'needsHuman is missing reason, deliverable or whyHuman' }
      }
      return {
        kind: 'needs_human',
        gap: {
          reason: gap.reason,
          deliverable: gap.deliverable,
          whyHuman: gap.whyHuman,
          blocking: gap.blocking !== false,
        },
      }
    }
    case 'failed':
      return {
        kind: 'failed',
        error: {
          code: typeof value.error?.code === 'string' && value.error.code.length > 0 ? value.error.code : 'node-failed',
          message: typeof value.error?.message === 'string' && value.error.message.length > 0 ? value.error.message : 'the node reported failure',
        },
      }
    default:
      return { kind: 'invalid', message: `unknown envelope status ${JSON.stringify(value.status)}` }
  }
}

/**
 * Interpret a judge's verdict output.
 * @param {unknown} output - the judge node's `output`.
 * @returns {{verdict: 'accept'|'reject'|'needs_more', reasons: string[], conditions: string[]} | null} verdict, or null when malformed.
 */
export function parseVerdict(output) {
  if (output === null || typeof output !== 'object') return null
  const value = /** @type {Record<string, any>} */ (output)
  if (!['accept', 'reject', 'needs_more'].includes(value.verdict)) return null
  return {
    verdict: value.verdict,
    reasons: Array.isArray(value.reasons) ? value.reasons.filter((entry) => typeof entry === 'string') : [],
    conditions: Array.isArray(value.conditions) ? value.conditions.filter((entry) => typeof entry === 'string') : [],
  }
}
