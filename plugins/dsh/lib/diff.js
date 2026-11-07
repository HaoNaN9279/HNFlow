/**
 * A structural diff between two flow definitions.
 *
 * Publishing is a human action, and "what am I about to publish" should be a
 * data question, not a memory test. The diff is intentionally shallow and
 * deterministic: nodes and edges are compared by identity, and a changed entry
 * names the top-level fields that differ.
 */

import { canonicalJson } from './json.js'

/**
 * Key an edge by a stable identity, falling back to its endpoints and condition.
 * @param {Record<string, any>} edge - edge definition.
 * @param {number} index - position in the array.
 * @returns {string} key.
 */
function edgeKey(edge, index) {
  if (typeof edge?.id === 'string' && edge.id.length > 0) return edge.id
  return `${String(edge?.from ?? '?')}->${String(edge?.to ?? '?')}:${canonicalJson(edge?.when ?? null)}#${index}`
}

/**
 * Index a list by a key function.
 * @param {any[]} list - definitions.
 * @param {(entry: any, index: number) => string} keyOf - key function.
 * @returns {Map<string, any>} index.
 */
function indexBy(list, keyOf) {
  /** @type {Map<string, any>} */
  const index = new Map()
  ;(Array.isArray(list) ? list : []).forEach((entry, position) => index.set(keyOf(entry, position), entry))
  return index
}

/**
 * Compare two definitions.
 * @param {Record<string, any>} before - published definition.
 * @param {Record<string, any>} after - candidate definition.
 * @returns {Record<string, any>} diff.
 */
export function diffDefinitions(before, after) {
  const beforeNodes = indexBy(before?.nodes, (node) => String(node?.id ?? ''))
  const afterNodes = indexBy(after?.nodes, (node) => String(node?.id ?? ''))
  const beforeEdges = indexBy(before?.edges, edgeKey)
  const afterEdges = indexBy(after?.edges, edgeKey)

  /**
   * Compare two keyed lists.
   * @param {Map<string, any>} left - old.
   * @param {Map<string, any>} right - new.
   * @returns {{added: string[], removed: string[], changed: {id: string, fields: string[]}[]}} diff.
   */
  const compare = (left, right) => {
    /** @type {string[]} */
    const added = [...right.keys()].filter((key) => !left.has(key)).sort()
    /** @type {string[]} */
    const removed = [...left.keys()].filter((key) => !right.has(key)).sort()
    /** @type {{id: string, fields: string[]}[]} */
    const changed = []
    for (const key of [...right.keys()].filter((entry) => left.has(entry)).sort()) {
      const oldEntry = left.get(key)
      const newEntry = right.get(key)
      const fields = [...new Set([...Object.keys(oldEntry ?? {}), ...Object.keys(newEntry ?? {})])]
        .filter((field) => canonicalJson(oldEntry?.[field]) !== canonicalJson(newEntry?.[field]))
        .sort()
      if (fields.length > 0) changed.push({ id: key, fields })
    }
    return { added, removed, changed }
  }

  const nodes = compare(beforeNodes, afterNodes)
  const edges = compare(beforeEdges, afterEdges)
  const flowFields = [...new Set([...Object.keys(before?.flow ?? {}), ...Object.keys(after?.flow ?? {})])]
    .filter((field) => field !== 'updatedAt' && canonicalJson(before?.flow?.[field]) !== canonicalJson(after?.flow?.[field]))
    .sort()
  const inputChanged = canonicalJson(before?.input ?? null) !== canonicalJson(after?.input ?? null)
  const schemaVersionChanged = canonicalJson(before?.schemaVersion ?? null) !== canonicalJson(after?.schemaVersion ?? null)
  const changed = nodes.added.length + nodes.removed.length + nodes.changed.length + edges.added.length + edges.removed.length + edges.changed.length > 0 || flowFields.length > 0 || inputChanged || schemaVersionChanged
  /** @type {string[]} */
  const summary = []
  if (nodes.added.length > 0) summary.push(`+节点 ${nodes.added.join(', ')}`)
  if (nodes.removed.length > 0) summary.push(`-节点 ${nodes.removed.join(', ')}`)
  if (nodes.changed.length > 0) summary.push(`~节点 ${nodes.changed.map((entry) => `${entry.id}(${entry.fields.join('/')})`).join(', ')}`)
  if (edges.added.length > 0) summary.push(`+边 ${edges.added.join(', ')}`)
  if (edges.removed.length > 0) summary.push(`-边 ${edges.removed.join(', ')}`)
  if (edges.changed.length > 0) summary.push(`~边 ${edges.changed.map((entry) => entry.id).join(', ')}`)
  if (flowFields.length > 0) summary.push(`~流程字段 ${flowFields.join('/')}`)
  if (inputChanged) summary.push('~输入契约')
  if (schemaVersionChanged) summary.push('~schemaVersion')
  return {
    changed,
    contentChanged: canonicalJson(before) !== canonicalJson(after),
    flow: { changedFields: flowFields },
    inputChanged,
    schemaVersionChanged,
    nodes,
    edges,
    summary,
  }
}
