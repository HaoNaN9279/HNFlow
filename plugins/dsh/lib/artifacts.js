/**
 * Artifact bookkeeping for a run.
 *
 * The run record already stores every node output. An artifact entry is the
 * stable, addressable view of one of those outputs: it carries the producer,
 * the schema fingerprint and the acceptance/degradation facts, but not a second
 * copy of the value. `artifactView` resolves the value from the node state, so
 * the store cannot drift from itself and a large output is not duplicated.
 *
 * Artifact ids are deterministic per run + node: re-running a failed node
 * replaces its artifact instead of accumulating orphaned copies.
 */

import { declaredOutput } from './flow/definition.js'
import { hashOf } from './json.js'

/** Node types whose output is an artifact a human may inspect. */
const ARTIFACT_TYPES = new Set(['agent', 'judge', 'merge', 'request', 'verify'])

/**
 * The artifact id for one node output.
 * @param {Record<string, any>} run - run record.
 * @param {string} nodeId - node id.
 * @returns {string} artifact id.
 */
export function artifactIdFor(run, nodeId) {
  return `art-${String(run.runId).replace(/[^A-Za-z0-9_-]/gu, '')}-${nodeId}`
}

/**
 * Record (or refresh) the artifact produced by a node.
 *
 * Mutates the run record. A node whose output is absent gets no entry; a node
 * that previously produced an artifact keeps the same id.
 * @param {Record<string, any>} run - run record.
 * @param {Record<string, any>} node - node definition.
 * @param {{degraded?: boolean, degradedReason?: string, accepted?: boolean, source?: string}} [facts] - extra facts.
 * @returns {Record<string, any> | null} artifact entry, or null when the node type has no artifact.
 */
export function registerArtifact(run, node, facts = {}) {
  if (!ARTIFACT_TYPES.has(node?.type)) return null
  run.artifacts = run.artifacts !== null && typeof run.artifacts === 'object' && !Array.isArray(run.artifacts) ? run.artifacts : {}
  const artifactId = artifactIdFor(run, node.id)
  const entry = {
    artifactId,
    runId: run.runId,
    nodeId: node.id,
    kind: node.type,
    source: facts.source ?? (node.type === 'request' ? 'human' : node.type === 'judge' ? 'judge' : node.type === 'verify' ? 'plugin' : 'agent'),
    schemaHash: hashOf(declaredOutput(node)),
    degraded: facts.degraded === true,
    ...(facts.degraded === true && typeof facts.degradedReason === 'string' ? { degradedReason: facts.degradedReason } : {}),
    ...(facts.accepted === undefined ? {} : { accepted: facts.accepted }),
    createdAt: new Date().toISOString(),
  }
  run.artifacts[artifactId] = entry
  return entry
}

/**
 * Resolve an artifact plus its current value from a run.
 * @param {Record<string, any>} run - run record.
 * @param {string} artifactId - artifact id.
 * @returns {Record<string, any> | null} artifact view, or null when unknown.
 */
export function artifactView(run, artifactId) {
  const entry = run?.artifacts?.[artifactId]
  if (entry === null || typeof entry !== 'object') return null
  const state = run?.nodes?.[entry.nodeId]
  return {
    ...entry,
    status: state?.status ?? 'unknown',
    value: state?.output ?? null,
    ...(state?.verdict === undefined ? {} : { verdict: state.verdict }),
    ...(state?.diagnostic === undefined ? {} : { diagnostic: state.diagnostic }),
  }
}

/**
 * A compact artifact list for a run summary.
 * @param {Record<string, any>} run - run record.
 * @returns {{artifactId: string, nodeId: string, kind: string, degraded: boolean, accepted?: boolean}[]} entries.
 */
export function artifactList(run) {
  return Object.values(run?.artifacts ?? {}).map((entry) => ({
    artifactId: entry.artifactId,
    nodeId: entry.nodeId,
    kind: entry.kind,
    degraded: entry.degraded === true,
    ...(entry.accepted === undefined ? {} : { accepted: entry.accepted }),
  }))
}
