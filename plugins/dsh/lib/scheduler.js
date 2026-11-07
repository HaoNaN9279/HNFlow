/**
 * The pure part of the orchestrator: given a definition and a run record, which
 * nodes may run now, which are impossible, and how did the run end?
 *
 * No IO, no model, no timers. The service owns locking, spawning and storage;
 * this module owns the graph semantics, so every rule is testable with plain
 * objects.
 */

import { incomingEdges, nodeIndex, outgoingEdges } from './flow/definition.js'

/** Node states after which a node never runs again. */
export const TERMINAL_NODE_STATUSES = Object.freeze(['done', 'failed', 'skipped', 'blocked'])
/** Run states after which a run never advances again. */
export const TERMINAL_RUN_STATUSES = Object.freeze(['succeeded', 'failed', 'cancelled'])

/**
 * The current state of one node.
 * @param {Record<string, any>} run - run record.
 * @param {string} id - node id.
 * @returns {Record<string, any>} state (a detached default when unrecorded).
 */
export function nodeState(run, id) {
  const state = run?.nodes?.[id]
  if (state !== null && typeof state === 'object') return state
  return { status: 'pending', attempts: 0 }
}

/**
 * Whether a node state is terminal.
 * @param {string} status - node status.
 * @returns {boolean} true when terminal.
 */
export function isTerminalNode(status) {
  return TERMINAL_NODE_STATUSES.includes(status)
}

/**
 * Whether an edge condition currently holds.
 *
 * `null` means "not decidable yet": the source node has not settled.
 * @param {Record<string, any>} edge - edge definition.
 * @param {Record<string, any>} run - run record.
 * @returns {boolean | null} taken, not taken, or undecided.
 */
export function edgeTaken(edge, run) {
  const source = run?.nodes?.[edge?.from]
  if (source === null || typeof source !== 'object') return null
  if (!isTerminalNode(source.status)) return null
  const when = edge.when ?? { kind: 'always' }
  switch (when.kind) {
    case 'always':
      return source.status === 'done'
    case 'status':
      return source.status === when.is
    case 'verdict':
      return source.status === 'done' && source.verdict === when.is
    case 'gate':
      return source.status === 'done' && source.output?.decision === when.is
    case 'artifact.accepted':
      return source.status === 'done' && Boolean(source.output?.accepted) === when.is
    default:
      return null
  }
}

/**
 * Settle nodes that can never run: all predecessors settled, none took an edge.
 *
 * Mutates the run record. Returns the ids it settled so the caller can persist.
 * @param {Record<string, any>} flow - definition.
 * @param {Record<string, any>} run - run record.
 * @returns {{skipped: string[], blocked: string[]}} settled node ids.
 */
export function settle(flow, run) {
  /** @type {string[]} */
  const skipped = []
  /** @type {string[]} */
  const blocked = []
  let changed = true
  while (changed) {
    changed = false
    for (const id of nodeIndex(flow).keys()) {
      const state = nodeState(run, id)
      if (state.status !== 'pending') continue
      if (Array.isArray(run.fallbacks) && run.fallbacks.includes(id)) continue
      const incoming = incomingEdges(flow, id)
      if (incoming.length === 0) continue
      /** @type {boolean[]} */
      const states = []
      let undecided = false
      for (const edge of incoming) {
        const taken = edgeTaken(edge, run)
        if (taken === null) undecided = true
        else states.push(taken)
      }
      if (undecided) continue
      if (states.some(Boolean)) continue
      // Every predecessor settled and no edge was taken. A blocked predecessor
      // fails the run; anything else means this branch is simply unreachable.
      const blockedBy = incoming.some((edge) => {
        const source = run.nodes?.[edge?.from]
        if (source?.status !== 'failed') return false
        return (edge.onFail ?? { kind: 'block' }).kind === 'block'
      })
      run.nodes[id] = { ...state, status: blockedBy ? 'blocked' : 'skipped', endedAt: new Date().toISOString() }
      if (blockedBy) blocked.push(id)
      else skipped.push(id)
      changed = true
    }
  }
  return { skipped, blocked }
}

/**
 * Nodes that may start right now.
 * @param {Record<string, any>} flow - definition.
 * @param {Record<string, any>} run - run record.
 * @param {number} limit - how many to return.
 * @returns {string[]} node ids, sorted by id for stable ordering.
 */
export function runnableNodes(flow, run, limit = 3) {
  /** @type {string[]} */
  const ready = []
  for (const id of [...nodeIndex(flow).keys()].sort()) {
    const state = nodeState(run, id)
    if (state.status !== 'pending') continue
    if (Array.isArray(run.fallbacks) && run.fallbacks.includes(id)) {
      ready.push(id)
      continue
    }
    const incoming = incomingEdges(flow, id)
    if (incoming.length === 0) {
      ready.push(id)
      continue
    }
    let undecided = false
    let taken = false
    for (const edge of incoming) {
      const decision = edgeTaken(edge, run)
      if (decision === null) undecided = true
      else if (decision) taken = true
    }
    if (!undecided && taken) ready.push(id)
  }
  return ready.slice(0, Math.max(1, limit))
}

/**
 * Formal fallback activation: a failed node's outgoing edge may name another
 * node to run instead. Mutates the run's `fallbacks` list.
 * @param {Record<string, any>} flow - definition.
 * @param {Record<string, any>} run - run record.
 * @param {string} failedId - node that failed.
 * @returns {string[]} fallback node ids activated.
 */
export function activateFallbacks(flow, run, failedId) {
  /** @type {string[]} */
  const activated = []
  const fallbacks = Array.isArray(run.fallbacks) ? [...run.fallbacks] : []
  for (const edge of outgoingEdges(flow, failedId)) {
    if (edge?.onFail?.kind !== 'fallback') continue
    const target = edge.onFail.node
    if (typeof target !== 'string' || target === failedId) continue
    if (fallbacks.includes(target)) continue
    const state = nodeState(run, target)
    if (state.status !== 'pending') continue
    fallbacks.push(target)
    run.nodes[target] = { ...state, status: 'pending' }
    activated.push(target)
  }
  if (fallbacks.length > 0) run.fallbacks = fallbacks
  return activated
}

/**
 * Whether any node is still running or waiting.
 * @param {Record<string, any>} run - run record.
 * @returns {boolean} true when work is in flight.
 */
export function hasLiveNodes(run) {
  return Object.values(run?.nodes ?? {}).some((state) => state?.status === 'running' || state?.status === 'waiting')
}

/**
 * Whether every node settled.
 * @param {Record<string, any>} flow - definition.
 * @param {Record<string, any>} run - run record.
 * @returns {boolean} true when nothing is pending/running/waiting.
 */
export function allNodesSettled(flow, run) {
  for (const id of nodeIndex(flow).keys()) {
    const state = nodeState(run, id)
    if (state.status === 'pending' || state.status === 'running' || state.status === 'waiting') return false
  }
  return true
}

/**
 * The run status implied by its nodes and pending human work.
 * @param {Record<string, any>} flow - definition.
 * @param {Record<string, any>} run - run record.
 * @returns {'running'|'waiting_human'|'succeeded'|'failed'} implied status.
 */
export function impliedStatus(flow, run) {
  if (hasLiveNodes(run)) {
    return Object.values(run.nodes ?? {}).some((state) => state?.status === 'waiting') ? 'waiting_human' : 'running'
  }
  if (!allNodesSettled(flow, run)) return 'running'
  const failed = Object.values(run.nodes ?? {}).some((state) => state?.status === 'failed' || state?.status === 'blocked')
  return failed ? 'failed' : 'succeeded'
}

/**
 * Values a node produces for its consumers.
 * @param {Record<string, any>} flow - definition.
 * @param {Record<string, any>} run - run record.
 * @param {string} id - node id.
 * @returns {{from: string, edgeId: string, value: any}[]} upstream outputs in edge order.
 */
export function upstreamArtifacts(flow, run, id) {
  /** @type {{from: string, edgeId: string, value: any}[]} */
  const values = []
  for (const edge of incomingEdges(flow, id)) {
    const state = run.nodes?.[edge.from]
    if (state === undefined) continue
    if (edgeTaken(edge, run) !== true) continue
    const value = edge.port !== undefined && state.ports !== undefined ? state.ports[edge.port] : state.output
    values.push({ from: edge.from, edgeId: String(edge.id ?? ''), value })
  }
  return values
}

