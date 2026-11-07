/**
 * Publish-time static validation.
 *
 * Everything that can be decided from the declaration alone is decided here:
 * schema subset, contract assignability, bound inputs, gate coverage, judge
 * independence, preset and model-layer existence, graph shape. Nothing in this
 * module calls a model or starts a run; the page, `hnflow_author` and the
 * publisher share it.
 */

import {
  EDGE_WHEN_KINDS,
  GATE_DECISIONS,
  NODE_TYPES,
  VERDICTS,
  ancestorsOf,
  declaredInput,
  declaredOutput,
  endNodeIds,
  incomingEdges,
  nodeIndex,
  outgoingEdges,
  startNodeIds,
} from './definition.js'
import { SchemaError, assertObjectJsonSchema, isAssignable } from './schema.js'

/** Node id grammar: no path separators, no whitespace. */
export const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u

/**
 * Validate one flow definition.
 * @param {unknown} definition - candidate definition.
 * @param {{
 *   allowlist?: string[],
 *   checkPreset?: (id: string) => Promise<{ok: boolean, code?: string, message?: string}>,
 *   checkLayer?: (id: string) => Promise<{ok: boolean, code?: string, message?: string}>,
 *   vibestackAvailable?: boolean,
 * }} [options] - host facts the declaration cannot answer itself.
 * @returns {Promise<{ok: boolean, errors: {code: string, message: string, nodeId?: string, edgeId?: string, path?: string}[], warnings: string[]}>} result.
 */
export async function validateFlow(definition, options = {}) {
  const allowlist = Array.isArray(options.allowlist) ? options.allowlist : ['hnflow', 'standard']
  /** @type {{code: string, message: string, nodeId?: string, edgeId?: string, path?: string}[]} */
  const errors = []
  /** @type {string[]} */
  const warnings = []

  /**
   * Record one failure.
   * @param {string} code - stable reason.
   * @param {string} message - explanation.
   * @param {{nodeId?: string, edgeId?: string, path?: string}} [where] - location.
   * @returns {void}
   */
  const fail = (code, message, where = {}) => errors.push({ code, message, ...where })

  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
    fail('definition-invalid', 'the definition must be a JSON object')
    return { ok: false, errors, warnings }
  }
  const flow = /** @type {Record<string, any>} */ (definition)
  if (flow.flow === null || typeof flow.flow !== 'object' || Array.isArray(flow.flow)) {
    fail('definition-invalid', 'definition.flow must be an object')
    return { ok: false, errors, warnings }
  }
  if (typeof flow.flow.id !== 'string' || flow.flow.id.length === 0) fail('definition-invalid', 'definition.flow.id must be a non-empty string')
  if (typeof flow.flow.name !== 'string' || flow.flow.name.trim().length === 0) fail('definition-invalid', 'definition.flow.name must be a non-empty string')
  if (!Array.isArray(flow.nodes) || flow.nodes.length === 0) {
    fail('definition-invalid', 'definition.nodes must be a non-empty array')
    return { ok: false, errors, warnings }
  }
  if (!Array.isArray(flow.edges)) fail('definition-invalid', 'definition.edges must be an array')
  if (flow.input !== undefined) assertSchemaField(flow.input, 'definition.input', fail, {})

  const nodes = nodeIndex(flow)
  /** @type {Set<string>} */
  const seen = new Set()
  for (const node of flow.nodes) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      fail('definition-invalid', 'every node must be an object')
      continue
    }
    const id = node.id
    if (typeof id !== 'string' || !NODE_ID.test(id)) {
      fail('node-id-invalid', `node id ${JSON.stringify(id ?? '')} must match ${NODE_ID.source}`, { nodeId: String(id ?? '') })
      continue
    }
    if (seen.has(id)) {
      fail('node-id-invalid', `duplicate node id ${id}`, { nodeId: id })
      continue
    }
    seen.add(id)
    if (!NODE_TYPES.includes(node.type)) {
      fail('node-type-invalid', `node ${id} has unknown type ${JSON.stringify(node.type)}`, { nodeId: id })
      continue
    }
    const at = { nodeId: id }
    assertSchemaField(node.input, `${id}.input`, fail, at)
    if (node.model !== undefined) {
      if (typeof node.model !== 'string' || node.model.trim().length === 0) {
        fail('definition-invalid', `node ${id}.model must be a non-empty layer id`, at)
      } else if (options.vibestackAvailable === false) {
        fail('vibestack-unavailable', `node ${id} references model layer ${node.model} but VibeStack is unavailable`, at)
      }
    }
    switch (node.type) {
      case 'agent':
        checkAgentLike(node, at, fail)
        assertSchemaField(node.output, `${id}.output`, fail, at, { required: true })
        checkBudget(node, at, fail)
        if (node.allowHuman !== undefined && typeof node.allowHuman !== 'boolean') {
          fail('definition-invalid', `agent ${id}.allowHuman must be a boolean`, at)
        }
        checkRejectPolicy(node, at, fail)
        break
      case 'judge':
        checkAgentLike(node, at, fail)
        if (typeof node.criteria !== 'string' || node.criteria.trim().length === 0) {
          fail('definition-invalid', `judge ${id} needs criteria`, at)
        }
        break
      case 'merge':
        if (!Array.isArray(node.from)) {
          fail('definition-invalid', `merge ${id} needs a from array`, at)
        } else {
          for (const source of node.from) {
            if (typeof source !== 'string' || !nodes.has(source)) fail('definition-invalid', `merge ${id} reads unknown node ${JSON.stringify(source)}`, at)
          }
          if (node.from.length === 0 && (node.set === null || typeof node.set !== 'object' || Array.isArray(node.set) || Object.keys(node.set).length === 0)) {
            fail('definition-invalid', `merge ${id} needs at least one from source or a non-empty set`, at)
          }
        }
        checkMergeSet(node, at, fail)
        checkMergeMap(node, at, fail)
        assertSchemaField(node.output, `${id}.output`, fail, at, { required: true })
        break
      case 'gate':
        if (node.title !== undefined && typeof node.title !== 'string') fail('definition-invalid', `gate ${id}.title must be a string`, at)
        if (node.detail !== undefined && typeof node.detail !== 'string') fail('definition-invalid', `gate ${id}.detail must be a string`, at)
        checkDeadline(node, at, fail)
        checkExpirePolicy(node, at, fail)
        break
      case 'request':
        assertSchemaField(node.deliverable, `${id}.deliverable`, fail, at, { required: true })
        if (typeof node.whyHuman !== 'string' || node.whyHuman.trim().length === 0) {
          fail('request-contract-missing', `request ${id} must state whyHuman`, at)
        }
        if (node.deliverable === undefined) {
          fail('request-contract-missing', `request ${id} must declare a deliverable schema`, at)
        }
        checkDeadline(node, at, fail)
        checkExpirePolicy(node, at, fail)
        checkRejectPolicy(node, at, fail)
        break
      case 'verify': {
        const target = nodes.get(node.against)
        if (target === undefined) fail('definition-invalid', `verify ${id} references unknown node ${JSON.stringify(node.against ?? '')}`, at)
        else if (target.type !== 'request') fail('definition-invalid', `verify ${id} must verify a request node, not ${target.type}`, at)
        const checks = node.checks === undefined ? ['schema'] : node.checks
        if (!Array.isArray(checks) || checks.some((check) => !['schema', 'judge'].includes(check))) {
          fail('definition-invalid', `verify ${id}.checks must be a subset of ["schema","judge"]`, at)
        }
        if (Array.isArray(checks) && checks.includes('judge')) {
          if (node.judge === null || typeof node.judge !== 'object' || typeof node.judge.preset !== 'string') {
            fail('definition-invalid', `verify ${id} declares the judge check without judge.preset`, at)
          }
        }
        if (node.judge?.model !== undefined) {
          if (typeof node.judge.model !== 'string' || node.judge.model.trim().length === 0) {
            fail('definition-invalid', `verify ${id}.judge.model must be a non-empty layer id`, at)
          } else if (options.vibestackAvailable === false) {
            fail('vibestack-unavailable', `verify ${id} references model layer ${node.judge.model} but VibeStack is unavailable`, at)
          }
        }
        if (node.onInconclusive !== undefined && !['gate', 'fail'].includes(node.onInconclusive)) {
          fail('definition-invalid', `verify ${id}.onInconclusive must be "gate" or "fail"`, at)
        }
        checkRejectPolicy(node, at, fail)
        break
      }
      default:
        break
    }
    if (node.type !== 'judge' && node.type !== 'agent' && node.preset !== undefined) {
      // preset is meaningful on agent/judge only; a merge/gate/request that
      // names one is a sign the author expected a model call that never happens.
      fail('definition-invalid', `node ${id} of type ${node.type} cannot name a preset`, at)
    }
  }

  // Edges, contracts and gate coverage.
  for (const [index, edge] of (Array.isArray(flow.edges) ? flow.edges : []).entries()) {
    if (edge === null || typeof edge !== 'object' || Array.isArray(edge)) {
      fail('definition-invalid', `edge #${index + 1} must be an object`)
      continue
    }
    const edgeId = typeof edge.id === 'string' && edge.id.length > 0 ? edge.id : `#${index + 1}`
    const at = { edgeId }
    if (typeof edge.from !== 'string' || !nodes.has(edge.from)) {
      fail('edge-invalid', `edge ${edgeId} leaves unknown node ${JSON.stringify(edge.from ?? '')}`, at)
      continue
    }
    if (typeof edge.to !== 'string' || !nodes.has(edge.to)) {
      fail('edge-invalid', `edge ${edgeId} enters unknown node ${JSON.stringify(edge.to ?? '')}`, at)
      continue
    }
    const when = edge.when ?? { kind: 'always' }
    if (when === null || typeof when !== 'object' || !EDGE_WHEN_KINDS.includes(when.kind)) {
      fail('edge-invalid', `edge ${edgeId}.when.kind must be one of ${EDGE_WHEN_KINDS.join(', ')}`, at)
    } else if (!whenValueValid(when)) {
      fail('edge-invalid', `edge ${edgeId}.when.is is not valid for kind ${when.kind}`, at)
    }
    if (edge.onFail !== undefined) {
      const policy = edge.onFail
      if (policy === null || typeof policy !== 'object' || !['block', 'skip', 'fallback'].includes(policy.kind)) {
        fail('edge-invalid', `edge ${edgeId}.onFail.kind must be block, skip or fallback`, at)
      } else if (policy.kind === 'fallback' && (typeof policy.node !== 'string' || !nodes.has(policy.node))) {
        fail('edge-invalid', `edge ${edgeId}.onFail names unknown fallback node ${JSON.stringify(policy.node ?? '')}`, at)
      }
    }
    if (edge.accepts !== undefined) assertSchemaField(edge.accepts, `${edgeId}.accepts`, fail, at)

    const source = nodes.get(edge.from)
    const target = nodes.get(edge.to)
    if (source === undefined || target === undefined) continue
    const upstream = declaredOutput(source)
    const downstream = edge.accepts ?? declaredInput(target)
    if (downstream !== undefined) {
      const verdict = isAssignable(upstream, downstream, `${edgeId}.accepts`)
      if (!verdict.ok) {
        const first = verdict.violations[0]
        fail(
          'contract-unsatisfiable',
          `edge ${edgeId}: ${source.id} produces ${first.actual} at ${first.path} but ${target.id} expects ${first.expected}`,
          at,
        )
      }
    }
  }

  // A gate with outgoing edges must route all three outcomes; a gate with none
  // is itself the end of the flow, so its decision ends the run.
  for (const [id, node] of nodes) {
    if (node.type !== 'gate') continue
    const out = outgoingEdges(flow, id)
    if (out.length === 0) continue
    const covered = new Set(
      out
        .map((edge) => (edge?.when?.kind === 'gate' ? edge.when.is : null))
        .filter((value) => typeof value === 'string'),
    )
    const missing = GATE_DECISIONS.filter((decision) => !covered.has(decision))
    if (missing.length > 0) {
      fail('gate-branches-incomplete', `gate ${id} does not route ${missing.join(', ')}`, { nodeId: id })
    }
  }

  // Every required input needs a source.
  for (const [id, node] of nodes) {
    const input = declaredInput(node)
    const required = Array.isArray(input?.required) ? input.required : []
    if (required.length === 0) continue
    const incoming = incomingEdges(flow, id)
    for (const name of required) {
      if (incoming.length === 0) {
        const provided = flow.input?.properties !== null && typeof flow.input?.properties === 'object' && name in flow.input.properties
        if (!provided) fail('input-unbound', `node ${id} requires input.${name} but the flow does not provide it`, { nodeId: id })
        continue
      }
      const provided = incoming.some((edge) => {
        const source = nodes.get(edge?.from)
        if (source === undefined) return false
        const produced = declaredOutput(source)
        const producedProperties = produced.properties !== null && typeof produced.properties === 'object' ? produced.properties : {}
        if (name in producedProperties) return true
        // An open object can carry anything; a closed one cannot invent fields.
        return produced.additionalProperties !== false && (edge.accepts === undefined || edge.accepts.properties === null || typeof edge.accepts.properties !== 'object' || name in edge.accepts.properties)
      })
      if (!provided) fail('input-unbound', `node ${id} requires input.${name} but no incoming edge produces it`, { nodeId: id })
    }
  }

  // Judge independence: a judge — a judge node or a verify node's judge — must
  // run under a different preset than the producers whose artifacts it inspects.
  for (const [id, node] of nodes) {
    const judgePreset = node.type === 'judge' ? node.preset : node.type === 'verify' ? node.judge?.preset : undefined
    if (typeof judgePreset !== 'string') continue
    const producerPresets = new Set()
    for (const ancestor of ancestorsOf(flow, id)) {
      const ancestorNode = nodes.get(ancestor)
      if (ancestorNode?.type === 'agent' && typeof ancestorNode.preset === 'string') producerPresets.add(ancestorNode.preset)
    }
    if (producerPresets.has(judgePreset)) {
      fail('judge-same-as-producer', `judge ${id} uses preset ${judgePreset}, the same preset as its producer`, { nodeId: id })
    }
  }

  // Preset allowlist and existence.
  const presetChecks = []
  for (const [id, node] of nodes) {
    const presets = []
    if (typeof node.preset === 'string') presets.push(node.preset)
    if (node.type === 'verify' && typeof node.judge?.preset === 'string') presets.push(node.judge.preset)
    for (const preset of presets) {
      if (!allowlist.includes(preset)) {
        fail('preset-not-allowed', `node ${id} names preset ${preset}, outside the allowlist (${allowlist.join(', ')})`, { nodeId: id })
        continue
      }
      presetChecks.push({ id, preset })
    }
  }
  if (typeof options.checkPreset === 'function') {
    const cache = new Map()
    for (const { id, preset } of presetChecks) {
      if (!cache.has(preset)) cache.set(preset, await options.checkPreset(preset))
      const status = cache.get(preset)
      if (!status?.ok) {
        fail(status?.code ?? 'preset-unknown', `node ${id} names unavailable preset ${preset}${status?.message === undefined ? '' : `: ${status.message}`}`, { nodeId: id })
      }
    }
  }

  // Model layers.
  if (typeof options.checkLayer === 'function') {
    const cache = new Map()
    for (const [id, node] of nodes) {
      /** @type {{nodeId: string, layer: string}[]} */
      const wanted = []
      if (typeof node.model === 'string' && node.model.length > 0) wanted.push({ nodeId: id, layer: node.model })
      if (node.type === 'verify' && typeof node.judge?.model === 'string' && node.judge.model.length > 0) {
        wanted.push({ nodeId: `${id}:judge`, layer: node.judge.model })
      }
      for (const entry of wanted) {
        if (!cache.has(entry.layer)) cache.set(entry.layer, await options.checkLayer(entry.layer))
        const status = cache.get(entry.layer)
        if (!status?.ok) {
          fail(status?.code ?? 'model-layer-unknown', `node ${entry.nodeId} names unavailable model layer ${entry.layer}${status?.message === undefined ? '' : `: ${status.message}`}`, { nodeId: id })
        }
      }
    }
  }

  // Graph shape.
  checkAcyclic(flow, nodes, fail)
  const starts = startNodeIds(flow)
  const ends = endNodeIds(flow)
  if (starts.length !== 1) fail('graph-shape-invalid', `the flow must have exactly one start node, found ${starts.length} (${starts.join(', ') || 'none'})`)
  if (ends.length !== 1) fail('graph-shape-invalid', `the flow must have exactly one end node, found ${ends.length} (${ends.join(', ') || 'none'})`)

  return { ok: errors.length === 0, errors, warnings }
}

/**
 * Whether `when.is` fits its kind.
 * @param {Record<string, any>} when - edge condition.
 * @returns {boolean} true when valid.
 */
function whenValueValid(when) {
  switch (when.kind) {
    case 'always':
      return when.is === undefined
    case 'status':
      return ['done', 'failed', 'skipped'].includes(when.is)
    case 'verdict':
      return VERDICTS.includes(when.is)
    case 'gate':
      return GATE_DECISIONS.includes(when.is)
    case 'artifact.accepted':
      return typeof when.is === 'boolean'
    default:
      return false
  }
}

/**
 * Validate a merge's constant set.
 * @param {Record<string, any>} node - merge node.
 * @param {{nodeId: string}} at - location.
 * @param {(code: string, message: string, where?: object) => void} fail - collector.
 * @returns {void}
 */
function checkMergeSet(node, at, fail) {
  if (node.set === undefined) return
  if (node.set === null || typeof node.set !== 'object' || Array.isArray(node.set)) {
    fail('definition-invalid', `merge ${node.id}.set must be an object`, at)
    return
  }
  for (const key of Object.keys(node.set)) {
    if (key.trim().length === 0) fail('definition-invalid', `merge ${node.id}.set has an empty key`, at)
    try {
      JSON.stringify(node.set[key])
    } catch {
      fail('definition-invalid', `merge ${node.id}.set.${key} is not JSON-serializable`, at)
    }
  }
}

/**
 * Validate a merge's declarative map.
 *
 * Every mapped value names one of the merge's own sources, optionally followed
 * by a dot path. An unknown source would silently produce `undefined` at run
 * time, which is exactly the class of mistake static validation exists to stop.
 * @param {Record<string, any>} node - merge node.
 * @param {{nodeId: string}} at - location.
 * @param {(code: string, message: string, where?: object) => void} fail - collector.
 * @returns {void}
 */
function checkMergeMap(node, at, fail) {
  if (node.map === undefined) return
  if (node.map === null || typeof node.map !== 'object' || Array.isArray(node.map)) {
    fail('merge-map-invalid', `merge ${node.id}.map must be an object`, at)
    return
  }
  const sources = new Set(Array.isArray(node.from) ? node.from.filter((entry) => typeof entry === 'string') : [])
  for (const [target, source] of Object.entries(node.map)) {
    if (target.trim().length === 0) {
      fail('merge-map-invalid', `merge ${node.id}.map has an empty target name`, at)
      continue
    }
    if (typeof source !== 'string' || source.trim().length === 0) {
      fail('merge-map-invalid', `merge ${node.id}.map.${target} must be a non-empty source path`, at)
      continue
    }
    const [from, ...rest] = source.split('.')
    if (!sources.has(from)) {
      fail('merge-map-invalid', `merge ${node.id}.map.${target} reads ${from}, which is not one of [${[...sources].join(', ')}]`, at)
      continue
    }
    if (rest.some((part) => part.trim().length === 0)) {
      fail('merge-map-invalid', `merge ${node.id}.map.${target} has an empty path segment`, at)
    }
  }
}

/**
 * Validate a deadline declaration.
 * @param {Record<string, any>} node - gate/request node.
 * @param {{nodeId: string}} at - location.
 * @param {(code: string, message: string, where?: object) => void} fail - collector.
 * @returns {void}
 */
function checkDeadline(node, at, fail) {
  if (node.deadline === undefined) return
  if (node.deadline === null || typeof node.deadline !== 'object' || Array.isArray(node.deadline)) {
    fail('definition-invalid', `${node.type} ${node.id}.deadline must be an object`, at)
    return
  }
  if (node.deadline.hours !== undefined && (!Number.isFinite(node.deadline.hours) || node.deadline.hours <= 0)) {
    fail('definition-invalid', `${node.type} ${node.id}.deadline.hours must be a positive number`, at)
  }
}

/**
 * Validate an expiry policy.
 * @param {Record<string, any>} node - gate/request node.
 * @param {{nodeId: string}} at - location.
 * @param {(code: string, message: string, where?: object) => void} fail - collector.
 * @returns {void}
 */
function checkExpirePolicy(node, at, fail) {
  if (node.onExpire !== undefined && !['remind', 'fail'].includes(node.onExpire)) {
    fail('definition-invalid', `${node.type} ${node.id}.onExpire must be "remind" or "fail"`, at)
  }
}

/**
 * Validate a rejection policy.
 * @param {Record<string, any>} node - agent/request/verify node.
 * @param {{nodeId: string}} at - location.
 * @param {(code: string, message: string, where?: object) => void} fail - collector.
 * @returns {void}
 */
function checkRejectPolicy(node, at, fail) {
  if (node.onReject === undefined) return
  const policy = node.onReject
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    fail('reject-policy-invalid', `${node.type} ${node.id}.onReject must be an object`, at)
    return
  }
  if (!['return', 'fallback', 'arbitrate', 'fail'].includes(policy.kind)) {
    fail('reject-policy-invalid', `${node.type} ${node.id}.onReject.kind must be return, fallback, arbitrate or fail`, at)
  }
  if (policy.maxAttempts !== undefined && (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1)) {
    fail('reject-policy-invalid', `${node.type} ${node.id}.onReject.maxAttempts must be a positive integer`, at)
  }
  if (policy.kind === 'arbitrate' && policy.judge !== undefined) {
    if (policy.judge === null || typeof policy.judge !== 'object' || Array.isArray(policy.judge)) {
      fail('reject-policy-invalid', `${node.type} ${node.id}.onReject.judge must be an object`, at)
    } else if (policy.judge.preset !== undefined && (typeof policy.judge.preset !== 'string' || policy.judge.preset.trim().length === 0)) {
      fail('reject-policy-invalid', `${node.type} ${node.id}.onReject.judge.preset must be a non-empty preset id`, at)
    }
  }
}

/**
 * Validate an agent/judge nodule's shared fields.
 * @param {Record<string, any>} node - node.
 * @param {{nodeId: string}} at - location.
 * @param {(code: string, message: string, where?: object) => void} fail - collector.
 * @returns {void}
 */
function checkAgentLike(node, at, fail) {
  if (typeof node.preset !== 'string' || node.preset.trim().length === 0) {
    fail('definition-invalid', `node ${node.id} needs a preset`, at)
  }
  if (typeof node.instruction !== 'string' || node.instruction.trim().length === 0) {
    fail('definition-invalid', `node ${node.id} needs an instruction`, at)
  }
}

/**
 * Validate the attempt/timeout budget.
 * @param {Record<string, any>} node - node.
 * @param {{nodeId: string}} at - location.
 * @param {(code: string, message: string, where?: object) => void} fail - collector.
 * @returns {void}
 */
function checkBudget(node, at, fail) {
  if (node.budget === undefined) return
  if (node.budget === null || typeof node.budget !== 'object') {
    fail('definition-invalid', `node ${node.id}.budget must be an object`, at)
    return
  }
  if (node.budget.maxAttempts !== undefined && (!Number.isInteger(node.budget.maxAttempts) || node.budget.maxAttempts < 1)) {
    fail('definition-invalid', `node ${node.id}.budget.maxAttempts must be a positive integer`, at)
  }
  if (node.budget.timeoutMs !== undefined && (!Number.isFinite(node.budget.timeoutMs) || node.budget.timeoutMs <= 0)) {
    fail('definition-invalid', `node ${node.id}.budget.timeoutMs must be a positive number`, at)
  }
}

/**
 * Assert a schema field in the supported subset.
 * @param {unknown} schema - candidate schema.
 * @param {string} path - location.
 * @param {(code: string, message: string, where?: object) => void} fail - collector.
 * @param {{nodeId?: string, edgeId?: string}} at - node/edge identity.
 * @param {{required?: boolean}} [options] - whether absence is an error.
 * @returns {void}
 */
function assertSchemaField(schema, path, fail, at, options = {}) {
  if (schema === undefined) {
    if (options.required === true) fail('definition-invalid', `${path} is required`, at)
    return
  }
  try {
    assertObjectJsonSchema(schema, path)
  } catch (error) {
    if (error instanceof SchemaError) fail(error.code, error.message, at)
    else fail('schema-invalid', String(error?.message ?? error), at)
  }
}

/**
 * Detect a cycle with an iterative DFS.
 * @param {Record<string, any>} flow - definition.
 * @param {Map<string, Record<string, any>>} nodes - node index.
 * @param {(code: string, message: string, where?: object) => void} fail - collector.
 * @returns {void}
 */
function checkAcyclic(flow, nodes, fail) {
  /** @type {Map<string, 'visiting'|'done'>} */
  const state = new Map()
  for (const id of nodes.keys()) {
    if (state.has(id)) continue
    /** @type {{id: string, index: number}[]} */
    const stack = [{ id, index: 0 }]
    state.set(id, 'visiting')
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      const outgoing = outgoingEdges(flow, frame.id)
      if (frame.index >= outgoing.length) {
        state.set(frame.id, 'done')
        stack.pop()
        continue
      }
      const edge = outgoing[frame.index++]
      const next = edge?.to
      if (typeof next !== 'string' || !nodes.has(next)) continue
      if (state.get(next) === 'visiting') {
        fail('cycle-unsupported', `the flow contains a cycle through ${next}`, { edgeId: String(edge.id ?? ''), nodeId: next })
        return
      }
      if (state.get(next) === 'done') continue
      state.set(next, 'visiting')
      stack.push({ id: next, index: 0 })
    }
  }
}
