/**
 * Best-effort import of a legacy `WorkflowDefinition` (v1) into the six
 * primitives.
 *
 * The importer never guesses silently: every conversion, downgrade and drop is
 * reported, and the original file is untouched. A converted definition still
 * has to pass the normal static validation before it can become an asset.
 *
 * Legacy to v2 mapping (see plan appendix B):
 * - `flow:start` / `flow:end` are structural; edges to them are removed.
 * - `data:assign` becomes a constant `merge` (`set`), which keeps it
 *   deterministic and model-free.
 * - `ai:llm_agent` becomes `agent` (preset/instruction/output carried over).
 * - `human:review` becomes `gate`; `human:task` becomes `request`.
 * - `verify:gate` has no formal verifier in v2: it becomes a human `gate` and
 *   the loss of the verifier is reported.
 * - everything else is dropped with a reason.
 */

import { EDGE_WHEN_KINDS } from './flow/definition.js'

/** Old edge source ports that mean "approved", "rejected", "modified". */
const GATE_PORT = {
  verified: 'approved',
  pass: 'approved',
  passed: 'approved',
  approved: 'approved',
  accept: 'approved',
  accepted: 'approved',
  ok: 'approved',
  failed: 'rejected',
  fail: 'rejected',
  rejected: 'rejected',
  reject: 'rejected',
  bad: 'rejected',
  inconclusive: 'modified',
  unknown: 'modified',
  needs_more: 'modified',
  modified: 'modified',
}

/**
 * Whether a document looks like a legacy definition.
 * @param {Record<string, any>} definition - candidate.
 * @returns {boolean} true when legacy.
 */
export function isLegacyDefinition(definition) {
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) return false
  if (definition.schemaVersion !== 2) return true
  const nodes = Array.isArray(definition.nodes) ? definition.nodes : []
  if (nodes.some((node) => typeof node?.type === 'string' && node.type.includes(':'))) return true
  const edges = Array.isArray(definition.edges) ? definition.edges : []
  return edges.some((edge) => edge?.source !== undefined || edge?.target !== undefined)
}

/**
 * Convert one legacy definition.
 * @param {unknown} input - parsed legacy document.
 * @returns {{definition: Record<string, any>, report: Record<string, any>}} converted definition and report.
 */
export function convertDefinition(input) {
  /** @type {Record<string, any>} */
  const report = { legacy: false, changed: false, converted: [], dropped: [], warnings: [], notes: [] }
  if (!isLegacyDefinition(/** @type {any} */ (input))) {
    return { definition: /** @type {Record<string, any>} */ (input), report }
  }
  report.legacy = true
  const source = /** @type {Record<string, any>} */ (input)
  const oldNodes = Array.isArray(source.nodes) ? source.nodes : []
  const oldEdges = Array.isArray(source.edges) ? source.edges : []
  const flowId = String(source.flow?.id ?? source.id ?? 'imported-flow')
  const name = String(source.flow?.name ?? source.name ?? flowId)
  /** @type {Record<string, any>} */
  const definition = {
    schemaVersion: 2,
    flow: { id: flowId, name, ...(typeof source.description === 'string' ? { description: source.description } : {}) },
    input: source.input ?? { type: 'object', properties: {}, additionalProperties: true },
    nodes: [],
    edges: [],
  }
  const oldById = new Map(oldNodes.filter((node) => typeof node?.id === 'string').map((node) => [node.id, node]))
  /** @type {Map<string, string>} */
  const idMap = new Map()
  /** @type {Set<string>} */
  const droppedIds = new Set()

  for (const [index, node] of oldNodes.entries()) {
    if (node === null || typeof node !== 'object' || typeof node.id !== 'string') {
      report.dropped.push({ id: `#${index + 1}`, type: String(node?.type ?? ''), reason: 'node has no string id' })
      continue
    }
    const type = String(node.type ?? '')
    const id = sanitizeId(node.id, index)
    if (type === 'flow:start' || type === 'flow:end') {
      droppedIds.add(node.id)
      report.dropped.push({ id: node.id, type, reason: 'start/end are structural in v2' })
      continue
    }
    if (type === 'data:assign') {
      const outputs = Array.isArray(node.outputs) ? node.outputs.map((port) => String(port?.name ?? '')).filter((port) => port.length > 0) : []
      const value = node.params?.value
      const set = value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...value } : Object.fromEntries((outputs.length > 0 ? outputs : ['out']).map((port) => [port, value]))
      definition.nodes.push({ id, type: 'merge', from: [], set, output: { type: 'object' } })
      idMap.set(node.id, id)
      report.converted.push({ id: node.id, from: type, to: 'merge', reason: 'data:assign is a constant set' })
      continue
    }
    if (type === 'ai:llm_agent') {
      const params = node.params !== null && typeof node.params === 'object' ? node.params : {}
      /** @type {Record<string, any>} */
      const converted = {
        id,
        type: 'agent',
        preset: typeof params.preset === 'string' ? params.preset : typeof node.preset === 'string' ? node.preset : 'hnflow',
        instruction: String(params.instruction ?? node.instruction ?? node.name ?? `执行旧节点 ${node.id}`),
        output: params.output_schema ?? node.output_schema ?? { type: 'object' },
      }
      const model = params.model ?? node.model
      if (typeof model === 'string' && model.length > 0) converted.model = model
      definition.nodes.push(converted)
      idMap.set(node.id, id)
      report.converted.push({ id: node.id, from: type, to: 'agent', reason: 'preset replaces model_profile' })
      continue
    }
    if (type === 'human:review') {
      const params = node.params !== null && typeof node.params === 'object' ? node.params : {}
      definition.nodes.push({
        id,
        type: 'gate',
        title: String(node.name ?? node.id),
        detail: String(params.detail ?? params.instruction ?? node.description ?? ''),
      })
      idMap.set(node.id, id)
      report.converted.push({ id: node.id, from: type, to: 'gate', reason: 'human review is a gate' })
      continue
    }
    if (type === 'human:task') {
      const params = node.params !== null && typeof node.params === 'object' ? node.params : {}
      definition.nodes.push({
        id,
        type: 'request',
        deliverable: params.deliverable ?? node.output_schema ?? { type: 'object' },
        whyHuman: String(params.whyHuman ?? params.instruction ?? node.name ?? node.id),
      })
      idMap.set(node.id, id)
      report.converted.push({ id: node.id, from: type, to: 'request', reason: 'human task asks for a deliverable' })
      continue
    }
    if (type === 'verify:gate') {
      definition.nodes.push({
        id,
        type: 'gate',
        title: String(node.name ?? node.id),
        detail: String(node.params?.instruction ?? '旧流程的验证门禁；v2 没有内置形式化验证器，这里改由人裁决。'),
      })
      idMap.set(node.id, id)
      report.converted.push({ id: node.id, from: type, to: 'gate', reason: 'formal verifier downgraded to a human gate' })
      report.warnings.push(`${node.id}: verify:gate 的形式化验证器没有 v2 对应物，已降级为人工门禁`)
      continue
    }
    droppedIds.add(node.id)
    report.dropped.push({ id: node.id, type, reason: `unsupported legacy node type ${type}` })
  }

  /** @type {Set<string>} */
  const edgeIds = new Set()
  let edgeCounter = 0
  for (const edge of oldEdges) {
    if (edge === null || typeof edge !== 'object') continue
    const from = String(edge.from ?? edge.source ?? '')
    const to = String(edge.to ?? edge.target ?? '')
    if (droppedIds.has(from) || droppedIds.has(to)) continue
    const newFrom = idMap.get(from)
    const newTo = idMap.get(to)
    if (newFrom === undefined || newTo === undefined) {
      report.warnings.push(`边 ${from}->${to} 的端点没有导入，已丢弃`)
      continue
    }
    const oldSource = oldById.get(from)
    const when = legacyWhen(edge, oldSource)
    edgeCounter += 1
    let edgeId = typeof edge.id === 'string' && edge.id.length > 0 ? edge.id : `e-${edgeCounter}`
    while (edgeIds.has(edgeId)) edgeId = `${edgeId}-${edgeCounter}`
    edgeIds.add(edgeId)
    definition.edges.push({ id: edgeId, from: newFrom, to: newTo, when })
  }

  // A legacy flow has one end node; after dropping it, several branches may
  // dangle. Join them with a synthetic merge so the v2 "one end" rule holds.
  const outgoing = new Set(definition.edges.map((edge) => edge.from))
  const dangling = definition.nodes.filter((node) => !outgoing.has(node.id))
  if (dangling.length > 1) {
    const endId = uniqueId(definition.nodes, 'v2-end')
    definition.nodes.push({ id: endId, type: 'merge', from: dangling.map((node) => node.id), output: { type: 'object' } })
    for (const node of dangling) {
      const conditions = node.type === 'gate' ? ['approved', 'rejected', 'modified'] : [null]
      for (const condition of conditions) {
        edgeCounter += 1
        definition.edges.push({
          id: uniqueEdgeId(definition.edges, `e-end-${edgeCounter}`),
          from: node.id,
          to: endId,
          when: condition === null ? { kind: 'always' } : { kind: 'gate', is: condition },
        })
      }
    }
    report.notes.push(`新增合成终点 ${endId}，汇合 ${dangling.length} 条悬空分支`)
  }

  report.changed = report.converted.length > 0 || report.dropped.length > 0 || report.notes.length > 0
  return { definition, report }
}

/**
 * Translate one legacy edge's condition.
 * @param {Record<string, any>} edge - legacy edge.
 * @param {Record<string, any> | undefined} source - legacy source node.
 * @returns {Record<string, any>} v2 condition.
 */
function legacyWhen(edge, source) {
  const when = edge.when
  if (when !== null && typeof when === 'object' && EDGE_WHEN_KINDS.includes(when.kind)) return when
  if (source?.type === 'verify:gate' || source?.type === 'human:review') {
    const port = String(edge.source_port ?? edge.port ?? '').toLowerCase()
    const decision = GATE_PORT[port]
    if (decision !== undefined) return { kind: 'gate', is: decision }
  }
  return { kind: 'always' }
}

/**
 * Make a legacy id usable as a v2 node id.
 * @param {string} id - legacy id.
 * @param {number} index - position for a fallback.
 * @returns {string} safe id.
 */
function sanitizeId(id, index) {
  const cleaned = id.replace(/[^A-Za-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64)
  if (cleaned.length === 0) return `node-${index + 1}`
  return /^[A-Za-z0-9]/u.test(cleaned) ? cleaned : `n-${cleaned}`.slice(0, 64)
}

/**
 * A node id not already used.
 * @param {Record<string, any>[]} nodes - current nodes.
 * @param {string} wanted - preferred id.
 * @returns {string} unique id.
 */
function uniqueId(nodes, wanted) {
  const used = new Set(nodes.map((node) => node.id))
  if (!used.has(wanted)) return wanted
  let counter = 2
  while (used.has(`${wanted}-${counter}`)) counter += 1
  return `${wanted}-${counter}`
}

/**
 * An edge id not already used.
 * @param {Record<string, any>[]} edges - current edges.
 * @param {string} wanted - preferred id.
 * @returns {string} unique id.
 */
function uniqueEdgeId(edges, wanted) {
  const used = new Set(edges.map((edge) => edge.id))
  if (!used.has(wanted)) return wanted
  let counter = 2
  while (used.has(`${wanted}-${counter}`)) counter += 1
  return `${wanted}-${counter}`
}

/**
 * A short human-readable import report.
 * @param {Record<string, any>} report - report from {@link convertDefinition}.
 * @returns {string} text.
 */
export function formatImportReport(report) {
  if (!report?.legacy) return '新格式定义，无需转换。'
  /** @type {string[]} */
  const lines = ['旧格式导入报告：']
  for (const entry of report.converted ?? []) lines.push(`  ~ ${entry.id}: ${entry.from} → ${entry.to}（${entry.reason}）`)
  for (const entry of report.dropped ?? []) lines.push(`  - ${entry.id}: ${entry.type}（${entry.reason}）`)
  for (const warning of report.warnings ?? []) lines.push(`  ! ${warning}`)
  for (const note of report.notes ?? []) lines.push(`  + ${note}`)
  if (report.dropped?.length > 0) lines.push('原文件未被修改；被丢弃的节点需要在 v2 里重新表达。')
  return lines.join('\n')
}
