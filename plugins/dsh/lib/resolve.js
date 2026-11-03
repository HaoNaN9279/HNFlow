/**
 * Resolve a workspace key to a runnable definition.
 *
 * Order (docs/dsh-plugin-plan.md §4.6):
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
   * Resolve one workspace key (alias or asset id).
   * @param {string} key - alias or asset id.
   * @returns {Promise<{key: string, alias: string, assetId: string, assetName: string, definition: Record<string, any>, source: 'override'|'ref'|'latest', revision: number|null, currentRevision: number, baseRevision: number|null, overrideChangedAt: string|null, drift: boolean, hash: string}>} resolved definition and its provenance.
   * @throws {ResolveError} when the ref, asset, or pinned revision is missing.
   */
  async resolve(key) {
    const ref = await this.workspace.findRef(key)
    if (ref === null) {
      throw new ResolveError('ref-missing', `no workflow named ${key} in this workspace`, { key })
    }
    const assetEntry = await this.#readAsset(ref.assetId)
    const currentRevision = Number(assetEntry.asset.revision ?? 1)
    const override = await this.workspace.readOverride(ref.assetId)

    if (override !== null) {
      const baseRevision = Number.isInteger(override.baseRevision) ? override.baseRevision : null
      return {
        key,
        alias: String(ref.alias ?? ''),
        assetId: ref.assetId,
        assetName: String(assetEntry.asset.name ?? ''),
        definition: override.definition,
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
      const snapshot = await this.assets.readRevision(ref.assetId, ref.revision)
      if (snapshot === null) {
        throw new ResolveError('revision-missing', `asset ${ref.assetId} has no snapshot for revision ${ref.revision}`, {
          assetId: ref.assetId,
          revision: ref.revision,
          currentRevision,
        })
      }
      return {
        key,
        alias: String(ref.alias ?? ''),
        assetId: ref.assetId,
        assetName: String(assetEntry.asset.name ?? ''),
        definition: snapshot,
        source: 'ref',
        revision: ref.revision,
        currentRevision,
        baseRevision: null,
        overrideChangedAt: null,
        drift: currentRevision > ref.revision,
        hash: hashOf(snapshot),
      }
    }

    return {
      key,
      alias: String(ref.alias ?? ''),
      assetId: ref.assetId,
      assetName: String(assetEntry.asset.name ?? ''),
      definition: assetEntry.definition,
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
    for (const ref of document.refs) {
      const override = overrides.get(ref.assetId) ?? null
      /** @type {Record<string, any>} */
      const entry = {
        alias: String(ref.alias ?? ''),
        assetId: ref.assetId,
        enabled: ref.enabled !== false,
        pinnedRevision: Number.isInteger(ref.revision) ? ref.revision : null,
        hasOverride: override !== null,
        overrideChangedAt: override?.updatedAt ?? null,
        overrideBaseRevision: override?.baseRevision ?? null,
      }
      try {
        const assetEntry = await this.#readAsset(ref.assetId)
        entry.name = String(assetEntry.asset.name ?? '')
        entry.description = String(assetEntry.asset.description ?? '')
        entry.currentRevision = Number(assetEntry.asset.revision ?? 1)
        entry.missing = false
        entry.drift = override !== null ? entry.currentRevision > Number(entry.overrideBaseRevision ?? 0) : entry.pinnedRevision !== null && entry.currentRevision > entry.pinnedRevision
      } catch (error) {
        entry.name = ''
        entry.missing = true
        entry.drift = false
        entry.error = error instanceof ResolveError || error instanceof AssetError ? error.code : 'asset-unreadable'
      }
      entries.push(entry)
    }
    return entries
  }

  /**
   * Read an asset, translating store errors into resolver codes.
   * @param {string} assetId - asset identity.
   * @returns {Promise<{asset: Record<string, any>, definition: Record<string, any>}>} the asset record.
   */
  async #readAsset(assetId) {
    try {
      return await this.assets.read(assetId)
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
