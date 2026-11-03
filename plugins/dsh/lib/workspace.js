/**
 * Workspace state: refs and overrides.
 *
 * A workspace never copies an asset to use it. It records a reference
 * (`workflows.json`) and, when the project needs different behaviour, a full
 * override copy. Deleting the override restores the asset revision — see
 * `docs/dsh-plugin-plan.md` §4.2, §4.3.
 */

import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'

import { readJsonOrNull, writeJson } from './assets.js'
import { ASSET_SUFFIX, overridePath, overridesDir, refsPath } from './paths.js'

/** Ref manifest version written by this plugin. */
export const REFS_VERSION = 1
/** Overrides keep a bounded change history. */
export const MAX_CHANGE_LOG = 20

/** A workspace-state failure with a stable code. */
export class WorkspaceError extends Error {
  /**
   * @param {string} code - stable reason (`ref-duplicate`, `ref-missing`, …).
   * @param {string} message - human-readable explanation.
   * @param {Record<string, unknown>} [data] - extra context.
   */
  constructor(code, message, data = {}) {
    super(message)
    this.name = 'WorkspaceError'
    this.code = code
    this.data = data
  }
}

/**
 * Per-workspace refs and overrides.
 */
export class WorkspaceStore {
  /**
   * @param {string} cwd - workspace root.
   * @param {{workspaceDir?: string}} config - plugin config.
   * @param {{logger?: {warn?: Function}}} [options] - diagnostics sink.
   */
  constructor(cwd, config, options = {}) {
    /** @type {string} */
    this.cwd = path.resolve(cwd)
    /** @type {{workspaceDir?: string}} */
    this.config = config
    this.logger = options.logger ?? {}
  }

  // ── refs ────────────────────────────────────────────────────────────────

  /**
   * Read the ref manifest.
   * @returns {Promise<{version: number, refs: Record<string, any>[]}>} the manifest (empty when absent).
   */
  async readRefs() {
    const raw = await readJsonOrNull(refsPath(this.cwd, this.config))
    if (raw === null) return { version: REFS_VERSION, refs: [] }
    if (!Array.isArray(raw?.refs)) throw new WorkspaceError('ref-manifest-invalid', 'workflows.json has no refs array')
    return { version: Number(raw.version ?? REFS_VERSION), refs: raw.refs.filter((entry) => entry && typeof entry.assetId === 'string') }
  }

  /**
   * Write the ref manifest atomically.
   * @param {{version?: number, refs: Record<string, any>[]}} document - manifest.
   * @returns {Promise<void>} resolves once written.
   */
  async writeRefs(document) {
    await writeJson(refsPath(this.cwd, this.config), { version: REFS_VERSION, refs: document.refs })
  }

  /**
   * Add (or refresh) a reference.
   * @param {{assetId: string, alias?: string, revision?: number|null, enabled?: boolean}} input - reference to add.
   * @returns {Promise<Record<string, any>>} the stored ref.
   */
  async addRef(input) {
    const document = await this.readRefs()
    const assetId = String(input.assetId ?? '').trim()
    if (assetId.length === 0) throw new WorkspaceError('ref-invalid', 'assetId must not be empty')
    const alias = String(input.alias ?? '').trim()
    const clash = document.refs.find((ref) => ref.assetId === assetId || (alias.length > 0 && ref.alias === alias))
    if (clash !== undefined) {
      throw new WorkspaceError('ref-duplicate', `workflow already referenced as ${clash.alias || clash.assetId}`, {
        assetId: clash.assetId,
        alias: clash.alias ?? '',
      })
    }
    /** @type {Record<string, any>} */
    const ref = {
      assetId,
      revision: Number.isInteger(input.revision) ? input.revision : null,
      alias,
      enabled: input.enabled !== false,
      addedAt: new Date().toISOString(),
    }
    document.refs.push(ref)
    await this.writeRefs(document)
    return ref
  }

  /**
   * Remove a reference by alias or asset id.
   * @param {string} key - alias or asset id.
   * @returns {Promise<Record<string, any>>} the removed ref.
   */
  async removeRef(key) {
    const document = await this.readRefs()
    const index = document.refs.findIndex((ref) => ref.assetId === key || ref.alias === key)
    if (index < 0) throw new WorkspaceError('ref-missing', `no reference named ${key}`, { key })
    const [removed] = document.refs.splice(index, 1)
    await this.writeRefs(document)
    return removed
  }

  /**
   * Find a reference by alias or asset id.
   * @param {string} key - alias or asset id.
   * @returns {Promise<Record<string, any> | null>} the ref, or null.
   */
  async findRef(key) {
    const document = await this.readRefs()
    return document.refs.find((ref) => ref.assetId === key || (typeof ref.alias === 'string' && ref.alias === key)) ?? null
  }

  // ── overrides ───────────────────────────────────────────────────────────

  /**
   * Read the override for an asset.
   * @param {string} assetId - asset identity.
   * @returns {Promise<Record<string, any> | null>} override document or null.
   */
  async readOverride(assetId) {
    return readJsonOrNull(overridePath(this.cwd, assetId, this.config))
  }

  /**
   * Write (or replace) an override.
   *
   * Every write appends to a bounded change log; the asset itself is untouched.
   * @param {{assetId: string, definition: Record<string, any>, baseRevision: number, note?: string, origin?: 'agent'|'user', updatedBy?: string}} input - override content.
   * @returns {Promise<Record<string, any>>} the stored override.
   */
  async writeOverride(input) {
    const assetId = String(input.assetId ?? '').trim()
    if (assetId.length === 0) throw new WorkspaceError('override-invalid', 'assetId must not be empty')
    const previous = await this.readOverride(assetId)
    const now = new Date().toISOString()
    const changeLog = Array.isArray(previous?.changeLog) ? [...previous.changeLog] : []
    const note = String(input.note ?? '').trim()
    if (note.length > 0) changeLog.push({ at: now, by: input.updatedBy ?? input.origin ?? 'user', summary: note.slice(0, 500) })
    /** @type {Record<string, any>} */
    const document = {
      assetId,
      baseRevision: Number.isInteger(input.baseRevision) ? input.baseRevision : Number(previous?.baseRevision ?? 1),
      origin: input.origin === 'agent' ? 'agent' : 'user',
      note,
      updatedAt: now,
      updatedBy: String(input.updatedBy ?? input.origin ?? 'user'),
      changeLog: changeLog.slice(-MAX_CHANGE_LOG),
      definition: input.definition,
    }
    await writeJson(overridePath(this.cwd, assetId, this.config), document)
    return document
  }

  /**
   * Delete the override, restoring the asset revision.
   * @param {string} assetId - asset identity.
   * @returns {Promise<boolean>} true when a file was removed.
   */
  async removeOverride(assetId) {
    try {
      await rm(overridePath(this.cwd, assetId, this.config))
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
  }

  /**
   * Every override in this workspace.
   * @returns {Promise<Map<string, Record<string, any>>>} asset id → override document.
   */
  async listOverrides() {
    const dir = overridesDir(this.cwd, this.config)
    /** @type {Map<string, Record<string, any>>} */
    const found = new Map()
    /** @type {import('node:fs').Dirent[]} */
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return found
      throw error
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(ASSET_SUFFIX)) continue
      try {
        const parsed = JSON.parse(await readFile(path.join(dir, entry.name), 'utf8'))
        if (typeof parsed?.assetId === 'string') found.set(parsed.assetId, parsed)
      } catch (error) {
        this.logger.warn?.('hnflow: ignoring unreadable override %s: %o', entry.name, error)
      }
    }
    return found
  }
}

/**
 * Ensure the workspace state directory exists.
 * @param {string} cwd - workspace root.
 * @param {{workspaceDir?: string}} config - plugin config.
 * @returns {Promise<void>} resolves once the directory exists.
 */
export async function ensureWorkspaceState(cwd, config) {
  await mkdir(path.join(path.resolve(cwd), config?.workspaceDir ?? '.hnflow'), { recursive: true })
}
