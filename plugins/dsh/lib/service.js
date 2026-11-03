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
