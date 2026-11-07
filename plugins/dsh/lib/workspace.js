/**
 * Workspace state: refs and overrides.
 *
 * A workspace never copies an asset to use it. It records a reference
 * (`flows.json`) and, when the project needs different behaviour, a full
 * override copy. Deleting the override restores the asset revision — see
 * `docs/dsh-plugin-plan-v2.md` §8.1.
 */

import { readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'

import { normalizeFolder, readJsonOrNull, writeJson } from './assets.js'
import { ASSET_SUFFIX, overridePath, overridesDir, refsPath } from './paths.js'

/** Ref manifest version written by this plugin. */
export const REFS_VERSION = 2
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
    if (!Array.isArray(raw?.refs)) throw new WorkspaceError('ref-manifest-invalid', 'flows.json has no refs array')
    return { version: Number(raw.version ?? REFS_VERSION), refs: raw.refs.filter((entry) => entry && typeof entry.flowId === 'string') }
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
   * @param {{flowId: string, alias?: string, revision?: number|null, enabled?: boolean}} input - reference to add.
   * @returns {Promise<Record<string, any>>} the stored ref.
   */
  async addRef(input) {
    const document = await this.readRefs()
    const flowId = String(input.flowId ?? '').trim()
    if (flowId.length === 0) throw new WorkspaceError('ref-invalid', 'flowId must not be empty')
    const alias = String(input.alias ?? '').trim()
    const clash = document.refs.find((ref) => ref.flowId === flowId || (alias.length > 0 && ref.alias === alias))
    if (clash !== undefined) {
      throw new WorkspaceError('ref-duplicate', `flow already referenced as ${clash.alias || clash.flowId}`, {
        flowId: clash.flowId,
        alias: clash.alias ?? '',
      })
    }
    /** @type {Record<string, any>} */
    const ref = {
      flowId,
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
   * Remove a reference by alias or flow id.
   * @param {string} key - alias or flow id.
   * @returns {Promise<Record<string, any>>} the removed ref.
   */
  async removeRef(key) {
    const document = await this.readRefs()
    const index = document.refs.findIndex((ref) => ref.flowId === key || ref.alias === key)
    if (index < 0) throw new WorkspaceError('ref-missing', `no reference named ${key}`, { key })
    const [removed] = document.refs.splice(index, 1)
    await this.writeRefs(document)
    return removed
  }

  /**
   * Find a reference by alias or flow id.
   * @param {string} key - alias or flow id.
   * @returns {Promise<Record<string, any> | null>} the ref, or null.
   */
  async findRef(key) {
    const document = await this.readRefs()
    return document.refs.find((ref) => ref.flowId === key || (typeof ref.alias === 'string' && ref.alias === key)) ?? null
  }

  /**
   * Change a reference's pin without touching any other field.
   * @param {string} key - alias or flow id.
   * @param {{revision: number|null, alias?: string}} change - new pin (`null` follows latest).
   * @returns {Promise<Record<string, any>>} the updated ref.
   */
  async updateRef(key, change) {
    const document = await this.readRefs()
    const ref = document.refs.find((entry) => entry.flowId === key || entry.alias === key)
    if (ref === undefined) throw new WorkspaceError('ref-missing', `no reference named ${key}`, { key })
    if (change.revision === null) ref.revision = null
    else if (Number.isInteger(change.revision)) ref.revision = change.revision
    else throw new WorkspaceError('ref-invalid', 'revision must be null or a positive integer', { key })
    if (typeof change.alias === 'string' && change.alias.length > 0) ref.alias = change.alias
    ref.updatedAt = new Date().toISOString()
    await this.writeRefs(document)
    return ref
  }

  // ── overrides ───────────────────────────────────────────────────────────

  /**
   * Read the override for a flow.
   * @param {string} flowId - flow identity.
   * @returns {Promise<Record<string, any> | null>} override document or null.
   */
  async readOverride(flowId) {
    return readJsonOrNull(overridePath(this.cwd, flowId, this.config))
  }

  /**
   * Write (or replace) an override.
   *
   * Every write appends to a bounded change log; the asset itself is untouched.
   * @param {{flowId: string, definition: Record<string, any>, baseRevision: number, note?: string, origin?: 'agent'|'user', updatedBy?: string, local?: boolean, folder?: string}} input - override content.
   * @returns {Promise<Record<string, any>>} the stored override.
   */
  async writeOverride(input) {
    const flowId = String(input.flowId ?? '').trim()
    if (flowId.length === 0) throw new WorkspaceError('override-invalid', 'flowId must not be empty')
    const previous = await this.readOverride(flowId)
    const now = new Date().toISOString()
    const changeLog = Array.isArray(previous?.changeLog) ? [...previous.changeLog] : []
    const note = String(input.note ?? '').trim()
    if (note.length > 0) changeLog.push({ at: now, by: input.updatedBy ?? input.origin ?? 'user', summary: note.slice(0, 500) })
    const local = input.local === true || previous?.local === true
    const folder = normalizeFolder(input.folder !== undefined ? input.folder : previous?.folder)
    /** @type {Record<string, any>} */
    const document = {
      flowId,
      assetId: flowId,
      baseRevision: Number.isInteger(input.baseRevision) ? input.baseRevision : Number(previous?.baseRevision ?? 1),
      origin: input.origin === 'agent' ? 'agent' : 'user',
      note,
      updatedAt: now,
      updatedBy: String(input.updatedBy ?? input.origin ?? 'user'),
      changeLog: changeLog.slice(-MAX_CHANGE_LOG),
      definition: input.definition,
    }
    // `local` marks a project-only draft that has no library reference. The
    // same override file keeps an ordinary workspace customization otherwise.
    if (local) document.local = true
    if (folder.length > 0) document.folder = folder
    await writeJson(overridePath(this.cwd, flowId, this.config), document)
    return document
  }

  /**
   * Delete the override, restoring the asset revision.
   * @param {string} flowId - flow identity.
   * @returns {Promise<boolean>} true when a file was removed.
   */
  async removeOverride(flowId) {
    try {
      await rm(overridePath(this.cwd, flowId, this.config))
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
  }

  /**
   * Every override in this workspace.
   * @returns {Promise<Map<string, Record<string, any>>>} flow id → override document.
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
        if (typeof parsed?.flowId === 'string') found.set(parsed.flowId, parsed)
      } catch (error) {
        this.logger.warn?.('hnflow: ignoring unreadable override %s: %o', entry.name, error)
      }
    }
    return found
  }
}
