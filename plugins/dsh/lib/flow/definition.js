/**
 * Structural helpers for a flow definition.
 *
 * A definition is plain JSON (`schemaVersion: 2`). Nothing here validates it —
 * `flow/validate.js` owns that — these helpers only answer structural questions
 * the scheduler, the publisher and the brief renderer all need.
 */

/** The six primitives. */
export const NODE_TYPES = Object.freeze(['agent', 'judge', 'merge', 'gate', 'request', 'verify'])
/** Gate outcomes every gate must route. */
export const GATE_DECISIONS = Object.freeze(['approved', 'rejected', 'modified'])
/** Edge condition kinds. */
export const EDGE_WHEN_KINDS = Object.freeze(['always', 'status', 'verdict', 'gate', 'artifact.accepted'])
/** Verdict values a judge may return. */
export const VERDICTS = Object.freeze(['accept', 'reject', 'needs_more'])

/**
 * Index nodes by id.
 * @param {Record<string, any>} flow - definition.
 * @returns {Map<string, Record<string, any>>} nodes by id.
 */
export function nodeIndex(flow) {
  /** @type {Map<string, Record<string, any>>} */
  const index = new Map()
  for (const node of Array.isArray(flow?.nodes) ? flow.nodes : []) {
    if (node !== null && typeof node === 'object' && typeof node.id === 'string') index.set(node.id, node)
  }
  return index
}

/**
 * Edges entering a node.
 * @param {Record<string, any>} flow - definition.
 * @param {string} id - node id.
 * @returns {Record<string, any>[]} edges.
 */
export function incomingEdges(flow, id) {
  return (Array.isArray(flow?.edges) ? flow.edges : []).filter((edge) => edge?.to === id)
}

/**
 * Edges leaving a node.
 * @param {Record<string, any>} flow - definition.
 * @param {string} id - node id.
 * @returns {Record<string, any>[]} edges.
 */
export function outgoingEdges(flow, id) {
  return (Array.isArray(flow?.edges) ? flow.edges : []).filter((edge) => edge?.from === id)
}

/**
 * Node ids with no incoming edge.
 * @param {Record<string, any>} flow - definition.
 * @returns {string[]} start ids.
 */
export function startNodeIds(flow) {
  const nodes = nodeIndex(flow)
  return [...nodes.keys()].filter((id) => incomingEdges(flow, id).length === 0)
}

/**
 * Node ids with no outgoing edge.
 * @param {Record<string, any>} flow - definition.
 * @returns {string[]} end ids.
 */
export function endNodeIds(flow) {
  const nodes = nodeIndex(flow)
  return [...nodes.keys()].filter((id) => outgoingEdges(flow, id).length === 0)
}

/**
 * Every ancestor of a node, following edges backwards.
 * @param {Record<string, any>} flow - definition.
 * @param {string} id - node id.
 * @returns {Set<string>} ancestor ids.
 */
export function ancestorsOf(flow, id) {
  /** @type {Set<string>} */
  const ancestors = new Set()
  /** @type {string[]} */
  const queue = incomingEdges(flow, id).map((edge) => edge.from)
  while (queue.length > 0) {
    const current = queue.pop()
    if (typeof current !== 'string' || ancestors.has(current)) continue
    ancestors.add(current)
    for (const edge of incomingEdges(flow, current)) queue.push(edge.from)
  }
  return ancestors
}

/**
 * The schema describing what a node produces on its `output` port.
 *
 * `agent`/`judge`/`merge` declare their own; the human primitives have fixed
 * shapes because the plugin, not the model, writes them.
 * @param {Record<string, any>} node - node definition.
 * @returns {Record<string, any>} JSON schema.
 */
export function declaredOutput(node) {
  switch (node?.type) {
    case 'agent':
    case 'merge':
      return node.output ?? { type: 'object' }
    case 'judge':
      return VERDICT_SCHEMA
    case 'gate':
      return GATE_OUTPUT_SCHEMA
    case 'request':
      return node.deliverable ?? { type: 'object' }
    case 'verify':
      return VERIFY_OUTPUT_SCHEMA
    default:
      return { type: 'object' }
  }
}

/**
 * The schema a node consumes on its `input` port.
 * @param {Record<string, any>} node - node definition.
 * @returns {Record<string, any> | undefined} schema, or undefined when unconstrained.
 */
export function declaredInput(node) {
  return node?.input ?? undefined
}

/** What a judge returns (the node output, not the envelope). */
export const VERDICT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['verdict', 'reasons'],
  properties: {
    verdict: { type: 'string', enum: [...VERDICTS] },
    reasons: { type: 'array', items: { type: 'string' } },
    conditions: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
})

/** What a gate produces once decided. */
export const GATE_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['decision'],
  properties: {
    decision: { type: 'string', enum: [...GATE_DECISIONS] },
    reason: { type: 'string' },
    decidedAt: { type: 'string' },
  },
  additionalProperties: false,
})

/** What a verify node produces. */
export const VERIFY_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['accepted', 'violations'],
  properties: {
    accepted: { type: 'boolean' },
    violations: { type: 'array', items: { type: 'object' } },
    judged: { type: 'boolean' },
  },
  additionalProperties: false,
})
