/**
 * Publishing: the only operation that advances a flow revision.
 *
 * A publish freezes three things at once — the definition, its content hash and
 * a lockfile naming every contract the definition relied on (preset, output
 * schema hash, model route, plugin and VibeStack versions). A run pins that
 * revision and the lockfile; resuming never re-reads "latest".
 */

import { hashOf } from '../json.js'
import { vibestackSnapshot } from '../layers.js'
import { declaredOutput, nodeIndex } from './definition.js'

/**
 * Hash a definition without its revision bookkeeping, so the same content
 * hashes equally at every revision and a real edit always changes the hash.
 * @param {Record<string, any>} definition - flow definition.
 * @returns {string} `sha256:…`.
 */
export function contentHash(definition) {
  const flow = definition?.flow !== null && typeof definition?.flow === 'object' ? { ...definition.flow } : {}
  delete flow.revision
  delete flow.updatedAt
  delete flow.publishedAt
  return hashOf({ ...definition, flow })
}

/**
 * Build the lockfile for one definition at one revision.
 * @param {{
 *   definition: Record<string, any>,
 *   revision: number,
 *   pluginVersion: string,
 *   vibestack: Record<string, any> | undefined,
 *   layerStatus?: (id: string) => Promise<{ok: boolean, layer?: Record<string, any>, message?: string}>,
 *   presetStatus?: (id: string) => Promise<{ok: boolean, broken?: string}>,
 *   now?: Date,
 * }} input - freeze input.
 * @returns {Promise<Record<string, any>>} lockfile.
 */
export async function buildLockfile(input) {
  const definition = input.definition
  const nodes = nodeIndex(definition)
  /** @type {Record<string, any>} */
  const nodeEntries = {}
  /** @type {Record<string, any>} */
  const models = {}
  /** @type {Record<string, any>} */
  const presets = {}

  for (const [id, node] of nodes) {
    /** @type {Record<string, any>} */
    const entry = {
      type: node.type,
      outputHash: hashOf(declaredOutput(node)),
    }
    if (typeof node.preset === 'string') entry.preset = node.preset
    if (node.type === 'verify' && typeof node.judge?.preset === 'string') entry.judgePreset = node.judge.preset
    if (typeof node.model === 'string') {
      entry.model = node.model
      if (typeof input.layerStatus === 'function' && models[node.model] === undefined) {
        const status = await input.layerStatus(node.model)
        models[node.model] = status.ok
          ? { ...status.layer }
          : { layer: node.model, error: status.message ?? 'unroutable' }
      } else if (input.layerStatus === undefined) {
        models[node.model] = { layer: node.model }
      }
    }
    if (node.type === 'verify' && typeof node.judge?.model === 'string') {
      entry.judgeModel = node.judge.model
      if (typeof input.layerStatus === 'function' && models[node.judge.model] === undefined) {
        const status = await input.layerStatus(node.judge.model)
        models[node.judge.model] = status.ok
          ? { ...status.layer }
          : { layer: node.judge.model, error: status.message ?? 'unroutable' }
      } else if (input.layerStatus === undefined) {
        models[node.judge.model] = { layer: node.judge.model }
      }
    }
    nodeEntries[id] = entry
  }

  for (const node of nodes.values()) {
    const ids = []
    if (typeof node.preset === 'string') ids.push(node.preset)
    if (node.type === 'verify' && typeof node.judge?.preset === 'string') ids.push(node.judge.preset)
    for (const preset of ids) {
      if (presets[preset] !== undefined) continue
      presets[preset] = typeof input.presetStatus === 'function' ? await input.presetStatus(preset) : { ok: true }
    }
  }

  return {
    flowId: String(definition?.flow?.id ?? ''),
    revision: input.revision,
    contentHash: contentHash(definition),
    pluginVersion: input.pluginVersion,
    vibestack: vibestackSnapshot(input.vibestack),
    nodes: nodeEntries,
    models,
    presets,
    createdAt: (input.now ?? new Date()).toISOString(),
  }
}

/**
 * Publish a definition as a new immutable revision.
 * @param {{
 *   assets: {save: (input: any) => Promise<any>},
 *   definition: Record<string, any>,
 *   note?: string,
 *   lockfile: Record<string, any>,
 * }} input - publish input.
 * @returns {Promise<{asset: Record<string, any>, revision: number, contentHash: string, lockfile: Record<string, any>}>} result.
 */
export async function publishFlow(input) {
  const flowId = String(input.definition?.flow?.id ?? '')
  if (flowId.length === 0) throw Object.assign(new Error('the definition has no flow.id'), { code: 'definition-invalid' })
  const stored = await input.assets.save({ assetId: flowId, definition: input.definition, note: input.note ?? '', lockfile: input.lockfile })
  return {
    asset: stored.asset,
    revision: Number(stored.revision),
    contentHash: contentHash(input.definition),
    lockfile: input.lockfile,
  }
}

/**
 * Compare a lockfile's pinned facts with the current host.
 *
 * A different plugin minor version is a warning — the revision still runs under
 * the current code. A different major version, or a VibeStack contract newer
 * than the mounted one, is blocking: those change the meaning of the lockfile.
 * @param {Record<string, any> | null} lockfile - pinned facts.
 * @param {{pluginVersion: string, vibestack: Record<string, any> | undefined}} current - current host.
 * @returns {{ok: boolean, reasons: string[], warnings: string[]}} compatibility result.
 */
export function lockfileProblems(lockfile, current) {
  /** @type {string[]} */
  const reasons = []
  /** @type {string[]} */
  const warnings = []
  if (lockfile === null || lockfile === undefined) {
    reasons.push('this revision has no lockfile')
    return { ok: false, reasons, warnings }
  }
  const publishedMajor = String(lockfile.pluginVersion ?? '').split('.')[0]
  const currentMajor = String(current.pluginVersion ?? '').split('.')[0]
  if (publishedMajor.length > 0 && currentMajor.length > 0 && publishedMajor !== currentMajor) {
    reasons.push(`the revision was published by plugin ${lockfile.pluginVersion}, this is ${current.pluginVersion} (major change)`)
  } else if (typeof lockfile.pluginVersion === 'string' && lockfile.pluginVersion !== current.pluginVersion) {
    warnings.push(`the revision was published by plugin ${lockfile.pluginVersion}, running ${current.pluginVersion}`)
  }
  const wanted = Number(lockfile.vibestack?.apiVersion)
  const actual = Number(vibestackSnapshot(current.vibestack).apiVersion)
  if (Number.isFinite(wanted) && Number.isFinite(actual) && wanted > actual) {
    reasons.push(`the revision needs VibeStack apiVersion ${wanted}, mounted ${actual}`)
  }
  return { ok: reasons.length === 0, reasons, warnings }
}
