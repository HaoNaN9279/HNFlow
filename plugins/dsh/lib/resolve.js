/**
 * Resolve a workspace key to a runnable definition.
 *
 * Order (docs/architecture.md):
 *
 * 1. an override in this workspace;
 * 2. the ref's pinned revision snapshot;
 * 3. the asset's current revision (follow-latest refs).
 *
 * Drift is reported, never auto-corrected: a pinned ref or a stale override is
 * a deliberate intent, so the caller decides whether to re-pin or reset.
 */

import { AssetError, AssetStore } from './assets.js'
import { hashOf } from './json.js'
import { WorkspaceError, WorkspaceStore } from './workspace.js'

/** A resolution failure with a stable code. */
export class ResolveError extends Error {
  /**
   * @param {string} code - `ref-missing`, `asset-missing`, `revision-missing`, …
   * @param {string} message - human-readable explanation.
   * @param {Record<string, unknown>} [data] - extra context.
   */
  constructor(code, message, data = {}) {
    super(message)
    this.name = 'ResolveError'
    this.code = code
    this.data = data
  }
}

/**
 * Resolve refs and overrides onto asset definitions.
 */
export class Resolver {
  /**
   * @param {{assets: AssetStore, workspace: WorkspaceStore}} stores - the two stores.
   */
  constructor(stores) {
    /** @type {AssetStore} */
    this.assets = stores.assets
    /** @type {WorkspaceStore} */
    this.workspace = stores.workspace
  }

  /**
   * Resolve one workspace key (alias or flow id).
   * @param {string} key - alias or flow id.
   * @returns {Promise<{key: string, alias: string, flowId: string, flowName: string, definition: Record<string, any>, lockfile: Record<string, any> | null, source: 'override'|'ref'|'latest', revision: number|null, currentRevision: number, baseRevision: number|null, overrideChangedAt: string|null, drift: boolean, hash: string}>} resolved definition and its provenance.
   * @throws {ResolveError} when the ref, asset, or pinned revision is missing.
   */
  async resolve(key) {
    let ref = await this.workspace.findRef(key)
    if (ref === null) ref = await this.#refByName(key)
    if (ref === null) {
      const local = await this.#findLocal(key)
      if (local !== null) return local
      throw new ResolveError('ref-missing', `no flow named ${key} in this workspace`, { key })
    }
    const assetEntry = await this.#readAsset(ref.flowId)
    const currentRevision = Number(assetEntry.asset.revision ?? 1)
    const override = await this.workspace.readOverride(ref.flowId)

    if (override !== null) {
      const baseRevision = Number.isInteger(override.baseRevision) ? override.baseRevision : null
      return {
        key,
        alias: String(ref.alias ?? ''),
        flowId: ref.flowId,
        flowName: String(assetEntry.asset.name ?? ''),
        definition: override.definition,
        lockfile: null,
        source: 'override',
        revision: Number.isInteger(ref.revision) ? ref.revision : currentRevision,
        currentRevision,
        baseRevision,
        overrideChangedAt: typeof override.updatedAt === 'string' ? override.updatedAt : null,
        drift: baseRevision !== null && currentRevision > baseRevision,
        hash: hashOf(override.definition),
      }
    }

    if (Number.isInteger(ref.revision)) {
      const record = await this.assets.readRevisionRecord(ref.flowId, ref.revision)
      if (record === null) {
        throw new ResolveError('revision-missing', `asset ${ref.flowId} has no snapshot for revision ${ref.revision}`, {
          flowId: ref.flowId,
          revision: ref.revision,
          currentRevision,
        })
      }
      return {
        key,
        alias: String(ref.alias ?? ''),
        flowId: ref.flowId,
        flowName: String(assetEntry.asset.name ?? ''),
        definition: record.definition,
        lockfile: record.lockfile,
        source: 'ref',
        revision: ref.revision,
        currentRevision,
        baseRevision: null,
        overrideChangedAt: null,
        drift: currentRevision > ref.revision,
        hash: hashOf(record.definition),
      }
    }

    return {
      key,
      alias: String(ref.alias ?? ''),
      flowId: ref.flowId,
      flowName: String(assetEntry.asset.name ?? ''),
      definition: assetEntry.definition,
      lockfile: null,
      source: 'latest',
      revision: currentRevision,
      currentRevision,
      baseRevision: null,
      overrideChangedAt: null,
      drift: false,
      hash: hashOf(assetEntry.definition),
    }
  }

  /**
   * Every reference in the workspace, with its resolution status.
   *
   * Unresolvable refs are reported (not thrown): the list must stay usable when
   * an asset was moved away.
   * @returns {Promise<Record<string, any>[]>} one entry per ref.
   */
  async catalogue() {
    const document = await this.workspace.readRefs()
    const overrides = await this.workspace.listOverrides()
    /** @type {Record<string, any>[]} */
    const entries = []
    /** @type {Set<string>} */
    const referenced = new Set()
    for (const ref of document.refs) {
      referenced.add(ref.flowId)
      const override = overrides.get(ref.flowId) ?? null
      /** @type {Record<string, any>} */
      const entry = {
        alias: String(ref.alias ?? ''),
        flowId: ref.flowId,
        assetId: ref.flowId,
        local: false,
        enabled: ref.enabled !== false,
        pinnedRevision: Number.isInteger(ref.revision) ? ref.revision : null,
        hasOverride: override !== null,
        overrideChangedAt: override?.updatedAt ?? null,
        overrideBaseRevision: override?.baseRevision ?? null,
      }
      try {
        const assetEntry = await this.#readAsset(ref.flowId)
        entry.name = String(assetEntry.asset.name ?? '')
        entry.description = String(assetEntry.asset.description ?? '')
        entry.folder = String(assetEntry.folder ?? '')
        entry.currentRevision = Number(assetEntry.asset.revision ?? 1)
        entry.missing = false
        entry.drift = override !== null ? entry.currentRevision > Number(entry.overrideBaseRevision ?? 0) : entry.pinnedRevision !== null && entry.currentRevision > entry.pinnedRevision
      } catch (error) {
        entry.name = ''
        entry.missing = true
        entry.drift = false
        entry.folder = ''
        entry.error = error instanceof ResolveError || error instanceof AssetError ? error.code : 'asset-unreadable'
      }
      entries.push(entry)
    }
    // A local flow is an override without a reference: it is created, edited
    // and run inside this workspace, and only `promote` turns it into a
    // library asset. Listing it here keeps the project tree honest.
    const locals = [...overrides.values()]
      .filter((document) => document.local === true && !referenced.has(String(document.flowId)))
      .sort((left, right) => String(left.definition?.flow?.name ?? left.flowId).localeCompare(String(right.definition?.flow?.name ?? right.flowId)))
    for (const document of locals) {
      const name = String(document.definition?.flow?.name ?? document.flowId)
      entries.push({
        alias: '',
        flowId: String(document.flowId),
        assetId: null,
        local: true,
        enabled: true,
        name,
        description: String(document.definition?.flow?.description ?? ''),
        folder: String(document.folder ?? ''),
        pinnedRevision: null,
        currentRevision: 0,
        hasOverride: false,
        overrideBaseRevision: null,
        overrideChangedAt: String(document.updatedAt ?? ''),
        missing: false,
        drift: false,
        source: 'local',
      })
    }
    return entries
  }

  /**
   * Find a referenced asset by its display name (when no alias matches).
   * @param {string} key - asset display name.
   * @returns {Promise<Record<string, any> | null>} ref, or null.
   */
  async #refByName(key) {
    const wanted = String(key ?? '').trim()
    if (wanted.length === 0) return null
    let entries
    try {
      entries = await this.assets.list()
    } catch {
      return null
    }
    const matches = entries.filter((entry) => entry.name === wanted)
    if (matches.length !== 1) return null
    return this.workspace.findRef(String(matches[0].id))
  }

  /**
   * Resolve a project-local draft (an override with no library reference).
   * @param {string} key - local flow id or name.
   * @returns {Promise<Record<string, any> | null>} resolution, or null.
   * @throws {ResolveError} `ref-ambiguous` when two locals share a name.
   */
  async #findLocal(key) {
    const wanted = String(key ?? '').trim()
    if (wanted.length === 0) return null
    const overrides = await this.workspace.listOverrides()
    const matches = [...overrides.values()].filter(
      (document) => document.local === true && (String(document.flowId) === wanted || String(document.definition?.flow?.name ?? '') === wanted),
    )
    if (matches.length === 0) return null
    if (matches.length > 1) throw new ResolveError('ref-ambiguous', `more than one local flow is named ${wanted}; use its flow id`, { key: wanted })
    const document = matches[0]
    return {
      key: wanted,
      alias: '',
      flowId: String(document.flowId),
      flowName: String(document.definition?.flow?.name ?? document.flowId),
      definition: document.definition,
      lockfile: null,
      source: 'local',
      local: true,
      folder: String(document.folder ?? ''),
      revision: null,
      currentRevision: 0,
      baseRevision: null,
      overrideChangedAt: typeof document.updatedAt === 'string' ? document.updatedAt : null,
      drift: false,
      hash: hashOf(document.definition),
    }
  }

  /**
   * Read an asset, translating store errors into resolver codes.
   * @param {string} flowId - flow identity.
   * @returns {Promise<{asset: Record<string, any>, definition: Record<string, any>}>} the asset record.
   */
  async #readAsset(flowId) {
    try {
      return await this.assets.read(flowId)
    } catch (error) {
      if (error instanceof AssetError) throw new ResolveError(error.code, error.message, error.data)
      throw error
    }
  }
}

/**
 * Build a resolver over a workspace.
 * @param {{cwd: string, config: Record<string, any>, libraryRoot: string, logger?: object}} input - wiring.
 * @returns {{assets: AssetStore, workspace: WorkspaceStore, resolver: Resolver}} the stores and resolver.
 */
export function createStores(input) {
  const assets = new AssetStore(input.libraryRoot, { logger: input.logger })
  const workspace = new WorkspaceStore(input.cwd, input.config, { logger: input.logger })
  return { assets, workspace, resolver: new Resolver({ assets, workspace }) }
}

export { AssetError, WorkspaceError }
