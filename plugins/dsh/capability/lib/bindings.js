/**
 * Machine-local model-layer bindings for DSH.
 *
 * The platform resolver owns the layer catalog (ids, labels, default). This
 * module only reads and writes `models.bindings.dsh` and the DSH-only custom
 * layer list `models.custom.dsh`. It never defines a platform layer id.
 *
 * The config file is shared with `hnflow-stack models`; writes are atomic.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Layer id grammar shared with the resolver. */
export const LAYER_ID = /^[a-z0-9][a-z0-9_-]*$/u
/** Maximum layer id length. */
export const MAX_LAYER_ID = 32
/** Default global config path below the home directory. */
export const CONFIG_RELATIVE = path.join('.config', 'capability', 'config.json')
/** Agent key used in the shared config; matches plugin.json `agent`. */
export const DEFAULT_AGENT = 'dsh'

/**
 * DSH's current local default route. The layer ids come from the platform
 * catalog; these values only say how DSH binds them when no config exists.
 */
export const DEFAULT_PROVIDER = 'deepseek-account'
export const DEFAULT_MODEL = 'deepseek-flash'

/**
 * Build default bindings for the given platform layer ids.
 * @param {string[]} layerIds - ids from the platform catalog.
 * @returns {Record<string, {provider: string, model: string}>} bindings.
 */
export function defaultBindings(layerIds = []) {
  return Object.fromEntries(
    layerIds.map((id) => [id, { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL }]),
  )
}

/**
 * Resolve the bindings file path.
 * @param {string} [modelsFile] - row config override; `~` is expanded.
 * @returns {string} absolute path.
 */
export function resolveModelsPath(modelsFile = '') {
  const value = String(modelsFile ?? '').trim()
  if (value.length === 0) return path.join(os.homedir(), CONFIG_RELATIVE)
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2))
  }
  return path.resolve(value)
}

/**
 * Validate one binding object.
 * @param {unknown} raw - proposed binding.
 * @param {string} layerId - layer id for diagnostics.
 * @param {string[]} warnings - collector.
 * @returns {{provider: string, model: string, reasoningEffort?: string} | null} binding or null.
 */
export function normalizeBinding(raw, layerId, warnings) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(`binding ${layerId} is not an object`)
    return null
  }
  const source = /** @type {Record<string, unknown>} */ (raw)
  const provider = typeof source.provider === 'string' ? source.provider.trim() : ''
  const model = typeof source.model === 'string' ? source.model.trim() : ''
  if (provider.length === 0 || model.length === 0) {
    warnings.push(`binding ${layerId} needs provider and model`)
    return null
  }
  const binding = { provider, model }
  if (typeof source.reasoningEffort === 'string' && source.reasoningEffort.trim().length > 0) {
    binding.reasoningEffort = source.reasoningEffort.trim()
  }
  return binding
}

/**
 * Normalize a bindings map or a legacy array.
 * @param {unknown} raw - bindings object or legacy array.
 * @param {string[]} warnings - collector.
 * @returns {Record<string, {provider: string, model: string, reasoningEffort?: string}>} bindings.
 */
export function normalizeBindings(raw, warnings) {
  const result = {}
  /** @type {[string, unknown][]} */
  let entries = []
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        warnings.push('legacy binding entry is not an object')
        continue
      }
      const id = typeof item.id === 'string' ? item.id.trim() : ''
      entries.push([id === 'flash' ? 'fast' : id, item])
    }
  } else if (raw && typeof raw === 'object') {
    entries = Object.entries(raw)
  } else if (raw !== undefined) {
    warnings.push('models.bindings.dsh must be an object')
    return result
  }
  for (const [rawId, value] of entries) {
    const id = String(rawId)
    if (id.length === 0 || id.length > MAX_LAYER_ID || !LAYER_ID.test(id)) {
      warnings.push(`binding has invalid layer id: ${JSON.stringify(rawId)}`)
      continue
    }
    const binding = normalizeBinding(value, id, warnings)
    if (binding === null) continue
    if (result[id] !== undefined) warnings.push(`duplicate binding: ${id}`)
    result[id] = binding
  }
  return result
}

/**
 * Normalize DSH-only custom layers.
 * @param {unknown} raw - custom layer array.
 * @param {string[]} warnings - collector.
 * @param {Set<string>} [reserved] - platform ids that custom layers must not shadow.
 * @returns {object[]} custom layers.
 */
export function normalizeCustomLayers(raw, warnings, reserved = new Set()) {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    warnings.push('models.custom.dsh must be an array')
    return []
  }
  const seen = new Set()
  const layers = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      warnings.push('custom layer is not an object')
      continue
    }
    const source = /** @type {Record<string, unknown>} */ (item)
    const id = typeof source.id === 'string' ? source.id.trim() : ''
    if (id.length === 0 || id.length > MAX_LAYER_ID || !LAYER_ID.test(id)) {
      warnings.push(`custom layer has invalid id: ${JSON.stringify(source.id ?? '')}`)
      continue
    }
    if (reserved.has(id)) {
      warnings.push(`custom layer ${id} shadows a platform layer`)
      continue
    }
    if (seen.has(id)) {
      warnings.push(`duplicate custom layer id: ${id}`)
      continue
    }
    const provider = typeof source.provider === 'string' ? source.provider.trim() : ''
    const model = typeof source.model === 'string' ? source.model.trim() : ''
    if (provider.length === 0 || model.length === 0) {
      warnings.push(`custom layer ${id} needs provider and model`)
      continue
    }
    seen.add(id)
    const layer = {
      id,
      label: typeof source.label === 'string' && source.label.trim().length > 0
        ? source.label.trim()
        : id,
      description: typeof source.description === 'string' ? source.description.trim() : '',
      provider,
      model,
      custom: true,
    }
    if (typeof source.reasoningEffort === 'string' && source.reasoningEffort.trim().length > 0) {
      layer.reasoningEffort = source.reasoningEffort.trim()
    }
    layers.push(layer)
  }
  return layers
}

/**
 * Read bindings and DSH-only custom layers.
 * @param {string} file - config path.
 * @param {string} [agent] - agent key.
 * @param {Set<string>} [reserved] - platform ids custom layers must not shadow.
 * @returns {Promise<{bindings: object, custom: object[], default: string | null, warnings: string[], legacy: boolean}>} models.
 */
export async function readModels(file, agent = DEFAULT_AGENT, reserved = new Set()) {
  const warnings = []
  let document = {}
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { bindings: {}, custom: [], default: null, warnings, legacy: false, useDefaults: true }
    }
    throw new Error(`cannot read ${file}: ${String(error?.message ?? error)}`)
  }
  try {
    document = JSON.parse(String(text).replace(/^\uFEFF/u, ''))
  } catch (error) {
    throw new Error(`cannot read ${file}: invalid JSON (${String(error?.message ?? error)})`)
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`cannot read ${file}: not a JSON object`)
  }
  const models = document.models
  if (models !== undefined && (models === null || typeof models !== 'object' || Array.isArray(models))) {
    warnings.push('models must be an object')
    return { bindings: {}, custom: [], default: null, warnings, legacy: false, useDefaults: true }
  }
  const section = models ?? {}
  const allBindings = section.bindings
  let raw = allBindings && typeof allBindings === 'object' && !Array.isArray(allBindings)
    ? allBindings[agent]
    : undefined
  let legacy = false
  if (raw === undefined && Array.isArray(section.layers)) {
    warnings.push('models.layers is a legacy format; run `hnflow-stack models migrate`')
    raw = section.layers
    legacy = true
  }
  const bindings = raw === undefined ? {} : normalizeBindings(raw, warnings)
  const useDefaults = raw === undefined
  const custom = normalizeCustomLayers(
    section.custom && typeof section.custom === 'object' && !Array.isArray(section.custom)
      ? section.custom[agent]
      : undefined,
    warnings,
    reserved,
  )
  const wanted = typeof section.default === 'string' ? section.default.trim() : ''
  return {
    bindings,
    custom,
    default: wanted === 'flash' ? 'fast' : wanted.length > 0 ? wanted : null,
    warnings,
    legacy,
    useDefaults,
  }
}

/**
 * Write bindings and custom layers atomically, preserving every other section.
 * @param {string} file - config path.
 * @param {{bindings?: object, custom?: object[], default?: string | null}} models - proposed state.
 * @param {string} [agent] - agent key.
 * @returns {Promise<void>} resolves after the rename.
 */
export async function writeModels(file, models, agent = DEFAULT_AGENT) {
  let document = {}
  try {
    const parsed = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/u, ''))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) document = parsed
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const section = document.models && typeof document.models === 'object' && !Array.isArray(document.models)
    ? { ...document.models }
    : {}
  const bindings = section.bindings && typeof section.bindings === 'object' && !Array.isArray(section.bindings)
    ? { ...section.bindings }
    : {}
  bindings[agent] = models.bindings ?? {}
  section.bindings = bindings
  const custom = section.custom && typeof section.custom === 'object' && !Array.isArray(section.custom)
    ? { ...section.custom }
    : {}
  custom[agent] = models.custom ?? []
  section.custom = custom
  if (models.default === undefined) {
    // Keep the existing default.
  } else if (models.default === null) {
    delete section.default
  } else {
    section.default = models.default
  }
  document.models = section
  if (document.schema_version === undefined) document.schema_version = 1
  const directory = path.dirname(file)
  await mkdir(directory, { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

/**
 * Hash one layer/binding state for change detection.
 * @param {object} value - snapshot.
 * @returns {string} short hash.
 */
export function stateDigest(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex').slice(0, 16)
}
