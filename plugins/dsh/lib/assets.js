/**
 * Flow assets: the reusable, versioned definitions.
 *
 * An asset is one JSON file under the library root:
 *
 * ```jsonc
 * { "asset": { "id": "fl-…", "revision": 3, … }, "definition": { … } }
 * ```
 *
 * Only an explicit publish (a user action) increments `revision`; nothing in
 * the agent path may call it. See `docs/dsh-plugin-plan-v2.md` §4.5.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { hashOf } from './json.js'
import { ASSET_SUFFIX, REVISIONS_DIR } from './paths.js'

/** A failure with a stable machine-readable code. */
export class AssetError extends Error {
  /**
   * @param {string} code - stable reason (`asset-missing`, `asset-invalid`, …).
   * @param {string} message - human-readable explanation.
   * @param {Record<string, unknown>} [data] - extra context for callers.
   */
  constructor(code, message, data = {}) {
    super(message)
    this.name = 'AssetError'
    this.code = code
    this.data = data
  }
}

/** Directory (inside the library root) holding immutable revision snapshots. */
export const REVISIONS_DIRECTORY = REVISIONS_DIR

/**
 * Slugify an asset name into a file name.
 * @param {string} name - display name.
 * @param {string} id - asset id, used as a collision suffix.
 * @returns {string} safe file name without the extension.
 */
export function assetFileName(name, id) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40)
  return `${slug.length > 0 ? slug : 'flow'}-${id.slice(-6)}`
}

/**
 * Cheap shape check for a flow definition object.
 * @param {unknown} definition - candidate definition.
 * @returns {string[]} problems; empty means it looks like a definition.
 */
export function definitionProblems(definition) {
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) return ['definition must be a JSON object']
  const source = /** @type {Record<string, any>} */ (definition)
  const problems = []
  const flow = source.flow
  if (flow === null || typeof flow !== 'object' || Array.isArray(flow)) problems.push('definition.flow must be an object')
  else {
    if (typeof flow.id !== 'string' || flow.id.length === 0) problems.push('definition.flow.id must be a non-empty string')
    if (typeof flow.name !== 'string' || flow.name.trim().length === 0) problems.push('definition.flow.name must be a non-empty string')
  }
  if (!Array.isArray(source.nodes) || source.nodes.length === 0) problems.push('definition.nodes must be a non-empty array')
  if (!Array.isArray(source.edges)) problems.push('definition.edges must be an array')
  return problems
}

/**
 * The library of flow assets.
 */
export class AssetStore {
  /**
   * @param {string} root - library root directory.
   * @param {{logger?: {warn?: Function}}} [options] - diagnostics sink.
   */
  constructor(root, options = {}) {
    /** @type {string} */
    this.root = root
    /** @type {{warn?: Function}} */
    this.logger = options.logger ?? {}
  }

  /**
   * Absolute path for a new asset file.
   * @param {string} folder - relative folder inside the library (may be empty).
   * @param {string} name - display name.
   * @param {string} id - asset id.
   * @returns {string} absolute file path.
   */
  pathFor(folder, name, id) {
    const dir = folder.length > 0 ? path.join(this.root, ...folder.split('/').filter((part) => part.length > 0)) : this.root
    return path.join(dir, `${assetFileName(name, id)}${ASSET_SUFFIX}`)
  }

  /**
   * Every asset in the library.
   * @returns {Promise<{id: string, name: string, description: string, revision: number, tags: string[], path: string, hash: string}[]>} summaries sorted by name.
   */
  async list() {
    const found = await this.#scan()
    return [...found.values()]
      .map((entry) => ({
        id: entry.asset.id,
        name: entry.asset.name,
        description: entry.asset.description ?? '',
        revision: entry.asset.revision ?? 1,
        tags: Array.isArray(entry.asset.tags) ? entry.asset.tags : [],
        path: entry.path,
        folder: this.#folderOf(entry.path),
        hash: hashOf(entry.definition),
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  /**
   * Read one asset by id.
   * @param {string} flowId - stable identity.
   * @returns {Promise<{asset: Record<string, unknown>, definition: Record<string, unknown>, path: string, hash: string}>} the asset record.
   * @throws {AssetError} `asset-missing` when the id is unknown.
   */
  async read(flowId) {
    const found = await this.#scan()
    const entry = found.get(flowId)
    if (entry === undefined) throw new AssetError('asset-missing', `no flow asset named ${flowId}`, { flowId })
    return { asset: entry.asset, definition: entry.definition, path: entry.path, folder: this.#folderOf(entry.path), hash: hashOf(entry.definition) }
  }

  /**
   * The library-relative folder of one asset file, with `/` separators.
   * @param {string} filePath - absolute asset path.
   * @returns {string} folder, or '' for the library root.
   */
  #folderOf(filePath) {
    return path
      .relative(this.root, path.dirname(filePath))
      .split(/[\\/]+/u)
      .filter((part) => part.length > 0 && part !== '.')
      .join('/')
  }

  /**
   * Read one immutable revision snapshot.
   *
   * Snapshots are what makes `revision` a real contract: a workspace ref pinned
   * to revision 3 keeps resolving to that definition after the asset advances.
   * @param {string} flowId - flow identity.
   * @param {number} revision - revision number.
   * @returns {Promise<Record<string, unknown> | null>} the definition, or null when that revision has no snapshot.
   */
  async readRevision(flowId, revision) {
    const record = await this.readRevisionRecord(flowId, revision)
    return record === null ? null : record.definition
  }

  /**
   * Read one immutable revision snapshot including its lockfile.
   * @param {string} flowId - flow identity.
   * @param {number} revision - revision number.
   * @returns {Promise<{definition: Record<string, any>, lockfile: Record<string, any> | null, snapshotAt: string | null} | null>} the record, or null.
   */
  async readRevisionRecord(flowId, revision) {
    const filePath = path.join(this.root, REVISIONS_DIRECTORY, flowId, `r${revision}.json`)
    const raw = await readJsonOrNull(filePath)
    if (raw === null || typeof raw.definition !== 'object' || raw.definition === null) return null
    return {
      definition: raw.definition,
      lockfile: raw.lockfile !== null && typeof raw.lockfile === 'object' ? raw.lockfile : null,
      snapshotAt: typeof raw.snapshotAt === 'string' ? raw.snapshotAt : null,
    }
  }

  /**
   * List the immutable snapshots that exist for one flow.
   * @param {string} flowId - flow identity.
   * @returns {Promise<{revision: number, snapshotAt: string | null, contentHash: string}[]>} revisions, newest first.
   */
  async listRevisions(flowId) {
    const directory = path.join(this.root, REVISIONS_DIRECTORY, flowId)
    /** @type {string[]} */
    let entries
    try {
      entries = await readdir(directory)
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    /** @type {{revision: number, snapshotAt: string | null, contentHash: string}[]} */
    const revisions = []
    for (const entry of entries) {
      const match = /^r(\d+)\.json$/u.exec(entry)
      if (match === null) continue
      const revision = Number(match[1])
      const record = await this.readRevisionRecord(flowId, revision)
      if (record === null) continue
      revisions.push({ revision, snapshotAt: record.snapshotAt, contentHash: hashOf(record.definition) })
    }
    return revisions.sort((left, right) => right.revision - left.revision)
  }

  /**
   * Write the snapshot for a stored revision.
   * @param {string} flowId - flow identity.
   * @param {number} revision - revision number.
   * @param {Record<string, unknown>} definition - definition stored at that revision.
   * @param {Record<string, unknown> | null} [lockfile] - frozen contracts of that revision.
   * @returns {Promise<void>} resolves once written.
   */
  async writeSnapshot(flowId, revision, definition, lockfile = null) {
    const filePath = path.join(this.root, REVISIONS_DIRECTORY, flowId, `r${revision}.json`)
    await writeJson(filePath, {
      flowId,
      assetId: flowId,
      revision,
      snapshotAt: new Date().toISOString(),
      definition,
      ...(lockfile === null ? {} : { lockfile }),
    })
  }

  /**
   * Create a new asset.
   * @param {{name: string, description?: string, definition: unknown, folder?: string, tags?: string[]}} input - new asset content.
   * @returns {Promise<{asset: Record<string, unknown>, path: string}>} the stored record.
   */
  async create(input) {
    const name = String(input.name ?? '').trim()
    if (name.length === 0) throw new AssetError('asset-invalid', 'asset name must not be empty')
    const problems = definitionProblems(input.definition)
    if (problems.length > 0) throw new AssetError('asset-invalid', problems.join('; '), { problems })
    const now = new Date().toISOString()
    const id = `fl-${randomUUID().replace(/-/gu, '').slice(0, 12)}`
    /** @type {Record<string, unknown>} */
    const asset = {
      id,
      name,
      description: String(input.description ?? '').trim(),
      revision: 1,
      tags: Array.isArray(input.tags) ? input.tags.filter((tag) => typeof tag === 'string') : [],
      createdAt: now,
      updatedAt: now,
    }
    const definition = withFlowIdentity(input.definition, id, name)
    const filePath = this.pathFor(String(input.folder ?? '').trim(), name, id)
    await writeJson(filePath, { asset, definition })
    await this.writeSnapshot(id, 1, definition)
    return { asset, path: filePath }
  }

  /**
   * Store a new revision of an existing asset (explicit user action only).
   * @param {{assetId: string, definition: unknown, note?: string, lockfile?: Record<string, any> | null}} input - new content.
   * @returns {Promise<{asset: Record<string, unknown>, path: string, revision: number, definition: Record<string, any>}>} the updated record.
   */
  async save(input) {
    const current = await this.read(input.assetId)
    const problems = definitionProblems(input.definition)
    if (problems.length > 0) throw new AssetError('asset-invalid', problems.join('; '), { problems })
    const revision = Number(current.asset.revision ?? 1) + 1
    const definition = withFlowIdentity(input.definition, String(current.asset.id), String(current.asset.name ?? ''))
    /** @type {Record<string, unknown>} */
    const asset = {
      ...current.asset,
      revision,
      updatedAt: new Date().toISOString(),
      lastNote: String(input.note ?? '').slice(0, 500),
    }
    await writeJson(current.path, { asset, definition })
    await this.writeSnapshot(input.assetId, revision, definition, input.lockfile ?? null)
    return { asset, path: current.path, revision, definition }
  }

  /**
   * Delete an asset file.
   * @param {string} flowId - stable identity.
   * @returns {Promise<{path: string}>} the removed path.
   */
  async remove(flowId) {
    const current = await this.read(flowId)
    await rm(current.path)
    return { path: current.path }
  }

  /**
   * Walk the library and index assets by id.
   * @returns {Promise<Map<string, {asset: Record<string, any>, definition: Record<string, any>, path: string}>>} index.
   */
  async #scan() {
    /** @type {Map<string, {asset: Record<string, any>, definition: Record<string, any>, path: string}>} */
    const index = new Map()
    const files = await this.#files(this.root)
    for (const filePath of files) {
      let parsed
      try {
        parsed = JSON.parse(await readFile(filePath, 'utf8'))
      } catch (error) {
        this.logger.warn?.('hnflow: ignoring unreadable asset %s: %o', filePath, error)
        continue
      }
      const asset = parsed?.asset
      const definition = parsed?.definition
      if (!asset || typeof asset.id !== 'string' || !definition || typeof definition !== 'object') {
        this.logger.warn?.('hnflow: ignoring malformed asset %s', filePath)
        continue
      }
      if (index.has(asset.id)) {
        this.logger.warn?.('hnflow: duplicate asset id %s (%s)', asset.id, filePath)
        continue
      }
      index.set(asset.id, { asset, definition, path: filePath })
    }
    return index
  }

  /**
   * Recursively list `*.flow.json` files, skipping dot-directories.
   * @param {string} dir - directory to walk.
   * @returns {Promise<string[]>} file paths.
   */
  async #files(dir) {
    /** @type {import('node:fs').Dirent[]} */
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    /** @type {string[]} */
    const files = []
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) files.push(...(await this.#files(full)))
      else if (entry.isFile() && entry.name.endsWith(ASSET_SUFFIX)) files.push(full)
    }
    return files
  }
}

/**
 * Force the definition's own identity to match its asset record.
 * @param {unknown} definition - candidate definition.
 * @param {string} id - asset id.
 * @param {string} name - asset display name.
 * @returns {Record<string, any>} definition with `flow.id`/`flow.name` set.
 */
export function withFlowIdentity(definition, id, name) {
  const source = /** @type {Record<string, any>} */ (definition)
  const flow = source.flow !== null && typeof source.flow === 'object' && !Array.isArray(source.flow) ? source.flow : {}
  return {
    ...source,
    schemaVersion: Number.isInteger(source.schemaVersion) ? source.schemaVersion : 2,
    flow: {
      ...flow,
      id,
      name: typeof flow.name === 'string' && flow.name.trim().length > 0 ? flow.name : name,
    },
  }
}

/**
 * Write JSON atomically: temp file in the same directory, then rename.
 * @param {string} filePath - destination.
 * @param {unknown} value - JSON payload.
 * @returns {Promise<void>} resolves once the rename completed.
 */
export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temp = `${filePath}.tmp-${randomUUID().slice(0, 8)}`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, filePath)
}

/**
 * Read JSON, treating a missing file as null.
 * @param {string} filePath - source.
 * @returns {Promise<any | null>} parsed value or null.
 */
export async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}
