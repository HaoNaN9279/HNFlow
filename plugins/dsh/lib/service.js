/**
 * The plugin's domain facade.
 *
 * One instance per mounted mode. It owns the per-workspace stores, the lazy
 * engine process, and the run registry — so the tool, the commands, and the
 * system-prompt section all read the same truth.
 *
 * Boundary rules enforced here (docs/dsh-plugin-plan.md §3.2):
 *
 * - nothing in the agent path writes an asset; only `saveAsset` does, and it
 *   exists for an explicit user action;
 * - an override is the only writable definition inside a workspace;
 * - the engine, not this process, decides a run's status.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { AssetError } from './assets.js'
import { resolveConfig } from './config.js'
import { EngineError, createEngineClient } from './engine.js'
import { engineCwd, libraryRoot, resolvePython } from './paths.js'
import { ResolveError, createStores } from './resolve.js'
import { WorkspaceError } from './workspace.js'

/** Terminal run states. */
export const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled'])

/** Non-terminal states that still end a wait: the run needs a human now. */
export const HOLDING_STATUSES = new Set(['waiting_human'])

/** Statuses the plugin may report before the engine assigns one. */
export const RUN_STATUSES = ['queued', 'running', 'waiting_human', 'interrupted', 'succeeded', 'failed', 'cancelled']

/**
 * Shared plugin behaviour.
 */
export class HnflowService {
  /**
   * @param {{config?: unknown, logger?: {warn?: Function, debug?: Function}, engine?: import('./engine.js').EngineClient}} options - plugin config.
   */
  constructor(options = {}) {
    /** @type {ReturnType<typeof resolveConfig>} */
    this.config = resolveConfig(options.config)
    /** @type {{warn?: Function, debug?: Function}} */
    this.logger = options.logger ?? {}
    /** @type {Map<string, ReturnType<typeof createStores>>} */
    this.storesByCwd = new Map()
    /** @type {import('./engine.js').EngineClient | null} */
    this.engine = options.engine ?? null
    /** @type {Map<string, {runId: string, cwd: string, key: string, alias: string, assetId: string, startedAt: string}>} */
    this.runs = new Map()
    this.disposed = false
  }

  /**
   * Stores for one workspace (cached by resolved path).
   * @param {string} cwd - workspace root.
   * @returns {ReturnType<typeof createStores>} assets, workspace, and resolver.
   */
  storesFor(cwd) {
    const key = cwd
    const existing = this.storesByCwd.get(key)
    if (existing !== undefined) return existing
    const created = createStores({ cwd: key, config: this.config, libraryRoot: libraryRoot(this.config), logger: this.logger })
    this.storesByCwd.set(key, created)
    return created
  }

  /**
   * The engine client, created on first use.
   * @returns {import('./engine.js').EngineClient} client.
   * @throws {EngineError} `engine-not-configured` when no interpreter is found.
   */
  engineClient() {
    if (this.engine !== null) return this.engine
    const python = resolvePython(this.config)
    if (python === null) {
      throw new EngineError('engine-not-configured', 'cannot find a Python interpreter for the workflow engine; set `enginePython` in the plugin config or DSH_HNFLOW_PYTHON', {
        searched: engineCwd(this.config),
      })
    }
    this.engine = createEngineClient({
      python,
      module: this.config.engineModule,
      cwd: engineCwd(this.config),
      requestTimeoutMs: this.config.requestTimeoutMs,
      startupTimeoutMs: this.config.startupTimeoutMs,
      env: this.config.stateDir.length > 0 ? { HNFLOW_ENGINE_STATE: this.config.stateDir } : {},
      models: this.config.models,
      logger: this.logger,
    })
    return this.engine
  }

  /**
   * Ensure the engine is up.
   * @returns {Promise<Record<string, unknown>>} the handshake payload.
   */
  async ensureEngine() {
    return await this.engineClient().ensureStarted()
  }

  /**
   * Resolve one key in a workspace.
   * @param {string} cwd - workspace root.
   * @param {string} key - alias or asset id.
   * @returns {Promise<Record<string, any>>} resolved definition and provenance.
   */
  async resolve(cwd, key) {
    return await this.storesFor(cwd).resolver.resolve(key)
  }

  /**
   * Every ref in a workspace with its resolution status.
   * @param {string} cwd - workspace root.
   * @returns {Promise<Record<string, any>[]>} catalogue entries.
   */
  async listWorkflows(cwd) {
    return await this.storesFor(cwd).resolver.catalogue()
  }

  /**
   * Every asset in the library.
   * @param {string} cwd - any workspace root (assets are library-scoped).
   * @returns {Promise<Record<string, any>[]>} asset summaries.
   */
  async listAssets(cwd) {
    return await this.storesFor(cwd).assets.list()
  }

  /**
   * Start a run for a workspace key.
   *
   * The definition is resolved (override → pinned revision → latest) and frozen:
   * the engine receives the exact definition this call resolved.
   * @param {{cwd: string, key: string, inputs?: Record<string, any>}} input - run request.
   * @returns {Promise<Record<string, any>>} `{runId, status, startedAt, resolved}`.
   */
  async startRun(input) {
    const resolved = await this.resolve(input.cwd, input.key)
    const engine = this.engineClient()
    await engine.ensureStarted()
    const started = await engine.request('run/start', {
      definition: resolved.definition,
      inputs: input.inputs ?? {},
      metadata: {
        workflowAssetId: resolved.assetId,
        workflowAlias: resolved.alias,
        workflowSource: resolved.source,
        workflowRevision: resolved.revision,
        workflowHash: resolved.hash,
        workspace: input.cwd,
      },
    })
    this.runs.set(started.runId, {
      runId: started.runId,
      cwd: input.cwd,
      key: input.key,
      alias: resolved.alias,
      assetId: resolved.assetId,
      startedAt: started.startedAt,
    })
    return { ...started, resolved }
  }

  /**
   * Current status of a run.
   * @param {string} runId - engine run id.
   * @returns {Promise<Record<string, any>>} run record.
   */
  async status(runId) {
    return await this.engineClient().request('run/status', { runId })
  }

  /**
   * Ask the engine to stop a run.
   * @param {string} runId - engine run id.
   * @returns {Promise<Record<string, any>>} cancellation result.
   */
  async cancel(runId) {
    return await this.engineClient().request('run/cancel', { runId })
  }

  /**
   * Poll until the run settles or needs a human, or the wait budget runs out.
   * @param {string} runId - engine run id.
   * @param {number} waitMs - maximum wait.
   * @returns {Promise<Record<string, any>>} the last observed status.
   */
  async waitFor(runId, waitMs) {
    const deadline = Date.now() + Math.max(0, waitMs)
    let status = await this.status(runId)
    while (!TERMINAL_STATUSES.has(status.status) && !HOLDING_STATUSES.has(status.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      status = await this.status(runId)
    }
    return status
  }

  /**
   * Continue a run that an engine restart interrupted.
   * @param {string} runId - engine run id.
   * @returns {Promise<Record<string, any>>} `{runId, status}`.
   */
  async resume(runId) {
    return await this.engineClient().request('run/resume', { runId })
  }

  /**
   * Pending human tasks of a run.
   * @param {string} runId - engine run id.
   * @returns {Promise<Record<string, any>>} `{tasks: [...]}`.
   */
  async tasks(runId) {
    return await this.engineClient().request('task/list', { runId })
  }

  /**
   * A run's event log.
   * @param {string} runId - engine run id.
   * @param {number} [afterSeq] - only events after this sequence number.
   * @returns {Promise<Record<string, any>>} `{runId, events, status}`.
   */
  async events(runId, afterSeq = 0) {
    return await this.engineClient().request('run/events', { runId, afterSeq })
  }

  /**
   * Submit a human task and let the engine continue the run.
   * @param {{taskId: string, payload: Record<string, any>, revision?: number}} input - submission.
   * @returns {Promise<Record<string, any>>} `{taskId, runId, status, revision}`.
   */
  async submitTask(input) {
    const params = { taskId: input.taskId, payload: input.payload }
    if (Number.isInteger(input.revision)) params.revision = input.revision
    return await this.engineClient().request('task/submit', params)
  }

  /**
   * Write the workspace override for a key (never the asset).
   * @param {{cwd: string, key: string, definition?: Record<string, any>, note?: string, origin?: 'agent'|'user'}} input - override request.
   * @returns {Promise<Record<string, any>>} the stored override.
   */
  async writeOverride(input) {
    const stores = this.storesFor(input.cwd)
    const resolved = await stores.resolver.resolve(input.key)
    const definition = input.definition ?? resolved.definition
    return await stores.workspace.writeOverride({
      assetId: resolved.assetId,
      definition,
      baseRevision: resolved.currentRevision,
      note: input.note ?? '',
      origin: input.origin ?? 'user',
    })
  }

  /**
   * Validate a definition with the engine (no run is created).
   * @param {Record<string, any>} definition - candidate definition.
   * @returns {Promise<{valid: boolean, errors: string[]}>} validation result.
   */
  async validateDefinition(definition) {
    return await this.engineClient().request('workflow/validate', { definition })
  }

  /**
   * The engine's node/port catalog.
   * @returns {Promise<Record<string, any>>} catalog.
   */
  async schema() {
    return await this.engineClient().request('workflow/describe')
  }

  /**
   * Store a new asset revision (explicit user action only).
   *
   * The tool surface has no action that reaches this method; only the
   * `/workflow save asset` command does, because writing an asset changes what
   * every workspace referencing it will run next.
   * @param {{cwd: string, key: string, note?: string}} input - save request.
   * @returns {Promise<Record<string, any>>} `{assetId, previousRevision, revision, name}`.
   */
  async saveAsset(input) {
    const stores = this.storesFor(input.cwd)
    const resolved = await stores.resolver.resolve(input.key)
    if (resolved.source !== 'override') {
      throw new WorkspaceError('nothing-to-save', `${input.key} has no workspace override to save`, { key: input.key })
    }
    const saved = await stores.assets.save({ assetId: resolved.assetId, definition: resolved.definition, note: input.note ?? '' })
    return {
      assetId: resolved.assetId,
      name: String(saved.asset.name ?? ''),
      previousRevision: resolved.currentRevision,
      revision: saved.revision,
    }
  }

  /**
   * Create a new asset from a name (a start → end scaffold) or a definition.
   * @param {{cwd: string, name: string, description?: string, folder?: string, definition?: Record<string, any>}} input - creation request.
   * @returns {Promise<Record<string, any>>} `{assetId, name, revision, path}`.
   */
  async createAsset(input) {
    const stores = this.storesFor(input.cwd)
    const definition = input.definition ?? scaffoldDefinition(input.name)
    const created = await stores.assets.create({
      name: input.name,
      description: input.description ?? '',
      folder: input.folder ?? '',
      definition,
    })
    return { assetId: created.asset.id, name: created.asset.name, revision: created.asset.revision, path: created.path }
  }

  /**
   * Import a workflow file into the library as a new asset.
   *
   * Accepts the asset envelope, the engine's `serialize()` envelope, or a bare
   * definition — the three shapes existing HNFlow/DSH files come in.
   * @param {{cwd: string, path: string, name?: string, folder?: string}} input - import request.
   * @returns {Promise<Record<string, any>>} `{assetId, name, revision, source}`.
   */
  async importAsset(input) {
    const stores = this.storesFor(input.cwd)
    const source = path.resolve(input.cwd, input.path)
    let raw
    try {
      raw = JSON.parse(await readFile(source, 'utf8'))
    } catch (error) {
      throw new WorkspaceError('import-unreadable', `cannot read ${source}: ${error.message}`, { path: source })
    }
    const definition = definitionFromDocument(raw)
    if (definition === null) {
      throw new WorkspaceError('import-invalid', `${source} is not a workflow definition`, { path: source })
    }
    const name = input.name?.trim() || String(definition.name ?? path.basename(source).replace(/\.workflow\.json$/u, ''))
    const created = await stores.assets.create({ name, definition, folder: input.folder ?? '' })
    return { assetId: created.asset.id, name: created.asset.name, revision: created.asset.revision, source }
  }

  /**
   * Delete an asset, refusing while this workspace still references it.
   * @param {{cwd: string, assetId: string}} input - delete request.
   * @returns {Promise<{assetId: string, path: string, hadOverride: boolean}>} deletion result.
   */
  async deleteAsset(input) {
    const stores = this.storesFor(input.cwd)
    const catalogue = await stores.resolver.catalogue()
    const used = catalogue.find((entry) => entry.assetId === input.assetId)
    if (used !== undefined) {
      throw new WorkspaceError('asset-in-use', `${input.assetId} is referenced by this workspace as ${used.alias || used.assetId}`, {
        assetId: input.assetId,
        alias: used.alias,
      })
    }
    const hadOverride = (await stores.workspace.readOverride(input.assetId)) !== null
    const removed = await stores.assets.remove(input.assetId)
    if (hadOverride) await stores.workspace.removeOverride(input.assetId)
    return { assetId: input.assetId, path: removed.path, hadOverride }
  }

  /**
   * Re-pin a reference to the asset's current revision (or a given one).
   * @param {{cwd: string, key: string, revision?: number|null}} input - pin request.
   * @returns {Promise<Record<string, any>>} `{key, assetId, revision, currentRevision}`.
   */
  async repinRef(input) {
    const stores = this.storesFor(input.cwd)
    const resolved = await stores.resolver.resolve(input.key)
    const revision = input.revision === undefined ? resolved.currentRevision : input.revision
    const ref = await stores.workspace.updateRef(input.key, { revision })
    return { key: input.key, assetId: resolved.assetId, revision: ref.revision, currentRevision: resolved.currentRevision }
  }

  /**
   * Remove a workspace override (back to the asset revision).
   * @param {{cwd: string, key: string}} input - reset request.
   * @returns {Promise<{removed: boolean, assetId: string}>} reset result.
   */
  async resetOverride(input) {
    const stores = this.storesFor(input.cwd)
    const resolved = await stores.resolver.resolve(input.key)
    const removed = await stores.workspace.removeOverride(resolved.assetId)
    return { removed, assetId: resolved.assetId }
  }

  /**
   * Replace one node's `params` and store the result as the workspace override.
   *
   * This is the panel's edit path: it changes exactly one node, revalidates the
   * whole definition with the engine, and only then writes the override — the
   * asset is never touched.
   * @param {{cwd: string, key: string, nodeId: string, params: Record<string, any>}} input - edit.
   * @returns {Promise<{key: string, assetId: string, nodeId: string, baseRevision: number}>} result.
   */
  async setNodeParams(input) {
    if (input.params === null || typeof input.params !== 'object' || Array.isArray(input.params)) {
      throw new WorkspaceError('params-invalid', 'params must be a JSON object', { nodeId: input.nodeId })
    }
    const stores = this.storesFor(input.cwd)
    const resolved = await stores.resolver.resolve(input.key)
    const definition = structuredClone(resolved.definition)
    const node = (definition.nodes ?? []).find((entry) => entry.id === input.nodeId)
    if (node === undefined) {
      throw new WorkspaceError('node-missing', `workflow ${input.key} has no node ${input.nodeId}`, { nodeId: input.nodeId })
    }
    node.params = input.params
    const validation = await this.validateDefinition(definition)
    if (!validation.valid) {
      throw new WorkspaceError('definition-invalid', `the edited definition is invalid: ${(validation.errors ?? []).slice(0, 3).join('; ')}`, {
        errors: validation.errors ?? [],
      })
    }
    await stores.workspace.writeOverride({
      assetId: resolved.assetId,
      definition,
      baseRevision: resolved.currentRevision,
      note: `panel: node ${input.nodeId}`,
      origin: 'user',
    })
    return { key: input.key, assetId: resolved.assetId, nodeId: input.nodeId, baseRevision: resolved.currentRevision }
  }

  /**
   * The panel payload: the workspace catalogue plus one resolved definition.
   *
   * The client cannot read the asset files, so this is how it gets a definition
   * to draw. A missing or unresolvable key yields `selected: null` instead of an
   * error, because a partly-broken workspace must still open.
   * @param {string} cwd - workspace root.
   * @param {string} [key] - workflow alias or asset id; defaults to the first ref.
   * @returns {Promise<{workspace: string, workflows: Record<string, any>[], selected: Record<string, any> | null}>} payload.
   */
  async panelPayload(cwd, key) {
    const workflows = await this.listWorkflows(cwd)
    const fallback = workflows[0] === undefined ? null : workflows[0].alias || workflows[0].assetId
    const resolvedKey = typeof key === 'string' && key.trim().length > 0 ? key.trim() : fallback
    let selected = null
    if (resolvedKey !== null) {
      try {
        const resolved = await this.resolve(cwd, resolvedKey)
        selected = {
          key: resolvedKey,
          assetId: resolved.assetId,
          source: resolved.source,
          revision: resolved.revision,
          currentRevision: resolved.currentRevision,
          baseRevision: resolved.baseRevision,
          drift: resolved.drift,
          definition: resolved.definition,
        }
      } catch {
        selected = null
      }
    }
    return { workspace: cwd, workflows, selected }
  }

  /**
   * The workflow index injected into the system prompt.
   * @param {string} cwd - workspace root.
   * @returns {Promise<string>} a short markdown list, or an empty string.
   */
  async indexSection(cwd) {
    let entries
    try {
      entries = await this.listWorkflows(cwd)
    } catch (error) {
      this.logger.warn?.('hnflow: cannot read the workflow index: %o', error)
      return ''
    }
    const usable = entries.filter((entry) => entry.enabled !== false).slice(0, this.config.maxIndexEntries)
    if (usable.length === 0) return ''
    const lines = usable.map((entry) => {
      const name = entry.alias.length > 0 ? entry.alias : entry.assetId
      const description = entry.description.length > 0 ? ` — ${entry.description}` : ''
      const override = entry.hasOverride ? '（本项目有覆盖）' : ''
      return `- ${name}${description}${override}`
    })
    return ['This workspace references these HNFlow workflows. Call the `hnflow` tool with an explicit name to run one.', '', ...lines].join('\n')
  }

  /**
   * Stop the engine and drop cached stores.
   * @returns {void}
   */
  dispose() {
    this.disposed = true
    this.engine?.stop()
    this.engine = null
    this.storesByCwd.clear()
    this.runs.clear()
  }
}

export { AssetError, EngineError, ResolveError, WorkspaceError }

/**
 * A start → end scaffold for a brand-new asset.
 * @param {string} name - display name.
 * @returns {Record<string, any>} definition.
 */
export function scaffoldDefinition(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40)
  const id = slug.length > 0 ? slug : `workflow-${Math.random().toString(16).slice(2, 8)}`
  return {
    id,
    name: String(name ?? 'New workflow').trim() || 'New workflow',
    version: '0.1.0',
    nodes: [
      { id: 'start', type: 'flow:start', outputs: [{ name: 'out', type: 'data' }] },
      { id: 'end', type: 'flow:end', inputs: [{ name: 'in', type: 'data' }] },
    ],
    edges: [{ source: 'start', source_port: 'out', target: 'end', target_port: 'in' }],
  }
}

/**
 * Pick the definition out of the three file shapes we accept on import.
 * @param {unknown} raw - parsed JSON.
 * @returns {Record<string, any> | null} the definition, or null when the file is not one.
 */
export function definitionFromDocument(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const document = /** @type {Record<string, any>} */ (raw)
  if (document.definition !== null && typeof document.definition === 'object' && Array.isArray(document.definition?.nodes)) {
    return document.definition
  }
  if (document.workflow !== null && typeof document.workflow === 'object' && Array.isArray(document.workflow?.nodes)) {
    return document.workflow
  }
  if (Array.isArray(document.nodes) && Array.isArray(document.edges)) return document
  return null
}
