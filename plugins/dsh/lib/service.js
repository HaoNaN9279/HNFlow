/**
 * The HNFlow orchestrator.
 *
 * One core instance owns the run state machine: it decides which node may run,
 * spawns children through the subagent seam, interprets their envelopes, writes
 * evidence, and parks the run on gate/request nodes without holding a promise.
 * Human decisions and deliveries re-enter through public methods, which is why
 * a run survives a restart.
 *
 * The service never asks a child "are you done?" — completion is the plugin's
 * judgement, made from the envelope, the contracts and the verify node.
 */

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { mkdir, rm } from 'node:fs/promises'

import { createStore } from './store.js'
import { AssetStore, definitionProblems, normalizeFolder, readJsonOrNull, withFlowIdentity, writeJson } from './assets.js'
import { contentHash, buildLockfile, lockfileProblems, publishFlow } from './flow/publish.js'
import { nodeIndex, outgoingEdges } from './flow/definition.js'
import { envelopeSchema, judgeEnvelopeSchema, parseEnvelope, parseVerdict } from './flow/envelope.js'
import { validateValue } from './flow/schema.js'
import { validateFlow } from './flow/validate.js'
import { REQUIRED_API_VERSION, agentOptionsOf, layerStatus, capabilityAvailable, capabilityOf, capabilityWarnings } from './layers.js'
import { buildJudgeBrief, buildNodeBrief, renderRetrySection } from './prompt.js'
import { createSubagentRunner, withTimeout } from './runner.js'
import { activateFallbacks, impliedStatus, nodeState, runnableNodes, settle, upstreamArtifacts } from './scheduler.js'
import { createGatePending, decideGate, gateQuestion } from './gates.js'
import { checkDelivery, createRequestPending, rejectionStep } from './requests.js'
import { PLUGIN_VERSION } from './config.js'
import { createStores } from './resolve.js'
import { libraryRoot, stateDirectory } from './paths.js'
import { hashOf } from './json.js'
import { diffDefinitions } from './diff.js'
import { artifactList, artifactView, registerArtifact } from './artifacts.js'
import { checkDeliverablePaths } from './deliverable.js'
import { addUsage, usageFromSession } from './usage.js'
import { createChannels } from './channels.js'
import { createKindRegistry, normalizeKindResult } from './kinds.js'
import { createOutbox } from './outbox.js'
import { evaluateTriggers, readTriggers, runCompletedTriggers } from './triggers.js'
import { runHealth } from './health.js'
import { pendingSummary, sortPending, stageOf } from './inbox.js'
import { NODE_TYPES } from './flow/definition.js'

/** Run statuses that never advance again. */
const TERMINAL_RUN = new Set(['succeeded', 'failed', 'cancelled'])

/** A service failure with a stable code. */
export class HnflowError extends Error {
  /**
   * @param {string} code - stable code.
   * @param {string} message - explanation.
   * @param {Record<string, any>} [data] - extra detail (violations, node, …).
   */
  constructor(code, message, data = {}) {
    super(message)
    this.name = 'HnflowError'
    this.code = code
    this.data = data
  }
}

/**
 * Build the orchestrator.
 * @param {{
 *   ctx: Record<string, any>,
 *   config: Record<string, any>,
 *   logger?: Record<string, any>,
 *   now?: () => Date,
 *   runner?: Record<string, any>,
 *   store?: ReturnType<typeof createStore>,
 * }} options - wiring (tests inject runner/store).
 * @returns {ReturnType<typeof buildService>} service.
 */
export function createService(options) {
  return buildService(options)
}

/**
 * Build the service body.
 * @param {Parameters<typeof createService>[0]} options - wiring.
 * @returns {Record<string, any>} service.
 */
function buildService(options) {
  const ctx = options.ctx ?? {}
  const config = options.config ?? {}
  const logger = options.logger ?? {}
  const now = options.now ?? (() => new Date())

  // Service lookup goes through `ctx.get`: reading `ctx.storageDomain`
  // directly is a Cordis property access that throws "without inject" when the
  // provider lives in a nested scope, and that failure kills the whole core row
  // (no routes, no service, no preset). `get` returns undefined instead, which
  // takes the documented file-store fallback.
  const store = options.store ?? createStore({ storageDomain: ctx.get?.('storageDomain'), config, logger })
  const runner = options.runner ?? createSubagentRunner({ subagents: () => ctx.get?.('subagents') })

  /** Serialized mutation chains, one per run. */
  const chains = new Map()
  /** Active activations per run, so cancel can dispose them. */
  const active = new Map()
  /** Cached conductor handle (page-started runs). */
  let conductorHandle = null
  /** @type {Promise<Record<string, any> | null> | null} */
  let conductor = null
  /** Cached flow index per workspace. */
  const indexCache = new Map()

  /**
   * Drop the derived views after a flow file changes.
   * @param {string} cwd - workspace root.
   * @returns {void}
   */
  function invalidateViews(cwd) {
    indexCache.delete(String(cwd))
    try {
      hosts.capability()?.invalidatePlan?.(cwd)
    } catch {
      // A capability core without the invalidation seam is still usable.
    }
  }
  /** Set when the service is closing. */
  let disposed = false
  /** @type {Promise<void> | null} */
  let opened = null
  /** Extra node kinds (deterministic executors) registered by other plugins. */
  const kinds = createKindRegistry()
  /** Human-work delivery channels; the inbox stays authoritative. */
  const channels = createChannels({ logger })
  // The native question card is a channel, not the source of truth: disabling
  // it or failing to render it changes nothing about what the inbox holds.
  channels.register({
    id: 'card',
    title: '会话问题卡',
    send: async (payload) => askCard(payload.run, payload.node, payload.pending, payload.host),
  })
  /** Durable side effects: notices and run-completed triggers. */
  const outbox = createOutbox({ dir: stateDirectory(config), now, logger, maxAttempts: config.outboxMaxAttempts })
  /** Trigger bookkeeping, keyed by `<workspace>#<trigger id>`. */
  let triggerState = {}
  /** Workspaces the pass should evaluate triggers for. */
  const knownWorkspaces = new Set()
  /** Last pass report, surfaced to the page. */
  let lastPass = { at: null, error: null, expired: 0, effects: 0, triggers: 0, advanced: 0 }
  /** Re-entrancy guard: a slow pass must not stack up. */
  let passRunning = false

  /** Host services are read lazily: rows load in order. */
  const hosts = {
    /**
     * @returns {Record<string, any> | undefined} HNFlow model-layer service.
     */
    capability() {
      return capabilityOf(ctx)
    },
    /**
     * @returns {Record<string, any> | undefined} agent preset registry.
     */
    presets() {
      return ctx.get?.('agentPresets')
    },
    /**
     * @returns {Record<string, any> | undefined} agent registry/factory.
     */
    agents() {
      return ctx.get?.('agents')
    },
    /**
     * @returns {Record<string, any> | undefined} user-question service.
     */
    questions() {
      return ctx.get?.('userQuestions')
    },
    /**
     * @returns {Record<string, any> | undefined} live session store (usage evidence).
     */
    sessions() {
      return ctx.get?.('sessions')
    },
    /**
     * @returns {Record<string, any> | undefined} filesystem service (delivery path containment).
     */
    fs() {
      return ctx.get?.('fs')
    },
  }

  /**
   * Read the token usage of one child session, when it is still live.
   * @param {string | undefined} childId - child session id.
   * @returns {Record<string, number> | null} usage, or null when unavailable.
   */
  function usageOf(childId) {
    const sessions = hosts.sessions()
    if (sessions === undefined || typeof sessions.get !== 'function' || typeof childId !== 'string') return null
    try {
      return usageFromSession(sessions.get(childId))
    } catch {
      return null
    }
  }

  /**
   * Stamp a pending gate/request with the audit facts §6.5 requires.
   *
   * The facts are written when the question is opened — not when it is answered
   * — because "which revision was the human looking at" must not depend on a
   * later mutable read.
   * @param {Record<string, any>} flow - definition.
   * @param {Record<string, any>} run - run record.
   * @param {Record<string, any>} node - node definition.
   * @param {Record<string, any>} pending - pending record.
   * @param {Record<string, any>} [snapshot] - upstream snapshot.
   * @returns {Record<string, any>} the pending record.
   */
  function openPending(flow, run, node, pending, snapshot) {
    const upstream =
      snapshot ?? Object.fromEntries(upstreamArtifacts(flow, run, node.id).map((artifact) => [artifact.from, artifact.value]))
    pending.revision = run.revisionCounter ?? 0
    pending.askedAt = pending.createdAt
    pending.askedVia = 'inbox'
    pending.flowRevision = Number.isInteger(run.revision) ? run.revision : null
    pending.flowSource = run.source ?? 'latest'
    pending.contentHash = run.contentHash ?? null
    pending.upstreamHash = hashOf(upstream)
    pending.consumerNodeIds = outgoingEdges(flow, node.id).map((edge) => String(edge.to))
    pending.decidedBy = null
    run.pending.push(pending)
    return pending
  }

  /**
   * Run a job under a run's serialization chain.
   * @param {string} runId - run identity.
   * @param {() => Promise<any>} job - critical section.
   * @returns {Promise<any>} job result.
   */
  function enqueue(runId, job) {
    const tail = chains.get(runId) ?? Promise.resolve()
    const next = tail.then(job, job)
    chains.set(
      runId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  /**
   * Build the stores for one workspace.
   * @param {string} cwd - workspace root.
   * @returns {{assets: object, resolver: object}} stores.
   */
  function storesFor(cwd) {
    return createStores({ cwd, config, libraryRoot: libraryRoot(config), logger })
  }

  /**
   * The project-local group tree. Flows created in a workspace live here so
   * they are ordinary capability content with a normal path and id.
   * @param {string} cwd - workspace root.
   * @returns {string} `.hnflow/groups`.
   */
  function projectGroupsDir(cwd) {
    return path.join(cwd, '.hnflow', 'groups')
  }

  /**
   * Assert a resolved flow belongs to a project-local group.
   * @param {string} cwd - workspace root.
   * @param {Record<string, any>} resolved - resolution.
   * @returns {void}
   */
  function requireProjectFlow(cwd, resolved) {
    const root = `${path.resolve(projectGroupsDir(cwd))}${path.sep}`
    if (!path.resolve(String(resolved.path)).startsWith(root)) {
      throw new HnflowError('flow-not-local', `${resolved.flowName} belongs to group ${resolved.group}; only project-local flows can be edited here`)
    }
  }

  /**
   * Add a group to `.hnflow/stack.json` once.
   * @param {string} cwd - workspace root.
   * @param {string} group - group name.
   * @returns {Promise<void>}
   */
  async function ensureStackGroup(cwd, group) {
    const file = path.join(cwd, '.hnflow', 'stack.json')
    const stack = await readJsonOrNull(file) ?? {
      schema_version: 2,
      core: { name: 'core', version: '0.1.0' },
      groups: [],
    }
    stack.groups = Array.isArray(stack.groups) ? stack.groups : []
    if (!stack.groups.some((entry) => entry?.name === group)) {
      stack.groups.push({ name: group, version: '' })
      await writeJson(file, stack)
    }
  }

  /**
   * Ensure a project-local group exists on disk.
   * @param {string} cwd - workspace root.
   * @param {string} group - group name.
   * @returns {Promise<string>} group directory.
   */
  async function ensureProjectGroup(cwd, group) {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(group)) throw new HnflowError('group-invalid', `group must be a lowercase slug, got ${group}`)
    const directory = path.join(projectGroupsDir(cwd), group)
    const manifest = path.join(directory, 'group.json')
    if (await readJsonOrNull(manifest) === null) {
      await mkdir(directory, { recursive: true })
      await writeJson(manifest, {
        guid: randomUUID().replace(/-/gu, ''),
        name: group,
        version: '',
        description: 'Project-local flows',
      })
    }
    await ensureStackGroup(cwd, group)
    return directory
  }

  /**
   * Read the flow definition a run pinned.
   *
   * A run carries its own definition snapshot. That is what makes a draft
   * override executable without pretending it is a published revision, and it
   * keeps a run reproducible even if the library file or revision snapshot is
   * edited or removed afterwards.
   * @param {Record<string, any>} run - run record.
   * @returns {Promise<Record<string, any>>} definition.
   */
  async function flowOf(run) {
    if (run.definition !== null && typeof run.definition === 'object' && Array.isArray(run.definition.nodes)) return run.definition
    const { assets } = storesFor(run.workspace)
    if (Number.isInteger(run.revision)) {
      const record = await assets.readRevisionRecord(run.flowId, run.revision)
      if (record === null) throw new HnflowError('revision-missing', `revision ${run.revision} of ${run.flowId} is not in the library`)
      return record.definition
    }
    const asset = await assets.read(run.flowId)
    return asset.definition
  }

  /**
   * The current host facts used by static validation.
   * @returns {{allowlist: string[], capabilityAvailable: boolean, extraNodeKinds: Set<string>, checkPreset: Function, checkLayer: Function}} facts.
   */
  function hostFacts() {
    const capability = hosts.capability()
    return {
      allowlist: config.presetAllowlist,
      capabilityAvailable: capabilityAvailable(capability),
      extraNodeKinds: new Set(kinds.list().map((kind) => kind.id)),
      checkPreset: async (id) => {
        const presets = hosts.presets()
        if (presets === undefined || typeof presets.resolve !== 'function') return { ok: true }
        try {
          const record = await presets.resolve(id)
          if (record?.broken !== undefined) return { ok: false, code: 'preset-broken', message: String(record.broken) }
          return { ok: true }
        } catch (error) {
          return { ok: false, code: 'preset-unknown', message: String(error?.message ?? error) }
        }
      },
      checkLayer: (id) => layerStatus(capability, id),
    }
  }

  /**
   * Refuse work while the capability service is missing.
   * @returns {void}
   * @throws {HnflowError} `capability-unavailable`.
   */
  function requireCapability() {
    if (!capabilityAvailable(hosts.capability())) {
      throw new HnflowError('capability-unavailable', `HNFlow needs the capability service (apiVersion >= ${REQUIRED_API_VERSION}) for capability groups and model layers`)
    }
  }

  /**
   * The Capability contract as reported to the page and the breadcrumb.
   * @returns {{available: boolean, apiVersion: number | null, warnings: string[]}} facts.
   */
  function capabilityFacts() {
    const service = hosts.capability()
    return {
      available: capabilityAvailable(service),
      apiVersion: service === undefined || service === null ? null : Number(service.apiVersion) || null,
      warnings: capabilityWarnings(service),
    }
  }

  /**
   * Wait until the store finished opening.
   * @returns {Promise<void>} resolves once readable.
   */
  async function ready() {
    if (opened !== null) await opened
  }

  /**
   * Read one run or fail.
   * @param {string} runId - run identity.
   * @returns {Promise<Record<string, any>>} run record.
   */
  async function requireRun(runId) {
    await ready()
    const run = await store.getRun(runId)
    if (run === null) throw new HnflowError('run-missing', `no run named ${runId}`)
    return run
  }

  /**
   * Resolve a workspace key to a definition and its pinned facts.
   * @param {string} cwd - workspace root.
   * @param {string} key - alias or flow id.
   * @returns {Promise<Record<string, any>>} resolution.
   */
  async function resolveKey(cwd, key) {
    return storesFor(cwd).resolver.resolve(key)
  }

  /**
   * Resolve the capability plan for a workspace.
   *
   * The capability core owns the only resolver; HNFlow never walks
   * `capability-groups/` itself. A project without a usable plan has no flows,
   * which is a normal state rather than a crash.
   * @param {string} cwd - workspace root.
   * @returns {Promise<Record<string, any>[]>} resolved flow entries.
   */
  async function capabilityFlows(cwd) {
    const capability = hosts.capability()
    if (!capabilityAvailable(capability)) return []
    // The capability core exposes one plan for both injection and flows.
    if (typeof capability.planFor !== 'function') {
      throw new HnflowError('capability-unavailable', 'the capability core does not expose a plan')
    }
    let result
    try {
      result = await capability.planFor(cwd)
    } catch (error) {
      throw new HnflowError('capability-unavailable', `cannot resolve capability groups: ${String(error?.message ?? error)}`)
    }
    for (const warning of result?.warnings ?? []) logger?.warn?.('hnflow: %s', warning)
    const flows = Array.isArray(result?.plan?.flows) ? result.plan.flows : []
    return flows.filter((entry) => entry && typeof entry.path === 'string')
  }

  /**
   * Load one flow from the capability plan.
   * @param {string} cwd - workspace root.
   * @param {string} key - qualified id, flow id, or display name.
   * @returns {Promise<Record<string, any>>} resolution.
   */
  async function resolveGroupFlow(cwd, key) {
    const flows = await capabilityFlows(cwd)
    const wanted = String(key ?? '').trim()
    const matches = flows.filter((entry) => entry.id === wanted
      || entry.flow_id === wanted
      || entry.name === wanted
      || path.basename(entry.path, '.flow.json') === wanted)
    if (matches.length === 0) {
      throw new HnflowError('flow-missing', `no capability flow named ${wanted}; run list_flows to see the active groups`)
    }
    if (matches.length > 1) {
      throw new HnflowError('flow-ambiguous', `flow name ${wanted} matches ${matches.map((entry) => entry.id).join(', ')}; use the qualified id`)
    }
    const entry = matches[0]
    const definition = await readJsonOrNull(entry.path)
    if (definition === null) throw new HnflowError('flow-missing', `flow file ${entry.path} disappeared`)
    return {
      key: String(entry.id),
      flowId: String(entry.flow_id),
      flowName: String(entry.name || entry.flow_id),
      definition,
      source: 'capability',
      revision: null,
      local: false,
      lockfile: null,
      group: String(entry.group ?? ''),
      path: entry.path,
      requires: Array.isArray(entry.requires) ? entry.requires : [],
    }
  }

  /**
   * Project one plan flow into the catalogue shape the page already reads.
   * @param {Record<string, any>} entry - plan flow.
   * @returns {Record<string, any>} catalogue entry.
   */
  function catalogueEntry(entry) {
    return {
      alias: String(entry.id),
      flowId: String(entry.flow_id),
      assetId: String(entry.id),
      local: false,
      enabled: true,
      pinnedRevision: null,
      currentRevision: 0,
      hasOverride: false,
      overrideBaseRevision: null,
      overrideChangedAt: null,
      name: String(entry.name || entry.flow_id),
      description: String(entry.description ?? ''),
      folder: String(entry.group ?? ''),
      group: String(entry.group ?? ''),
      path: entry.path,
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      requires: Array.isArray(entry.requires) ? entry.requires : [],
      missing: false,
      drift: false,
      source: 'capability',
    }
  }

  /**
   * Refuse library-only actions for a project-local draft.
   * @param {Record<string, any>} resolved - resolution.
   * @param {string} action - action name used in the message.
   * @returns {void}
   * @throws {HnflowError} `local-flow` when the flow is local.
   */
  function rejectLocal(resolved, action) {
    if (resolved.local !== true) return
    throw new HnflowError('local-flow', `cannot ${action} ${resolved.flowName}: it is a project-local draft with no published revision; promote it to the library first`)
  }

  /**
   * Find a workspace ref by alias, flow id, or the asset's display name.
   * @param {string} cwd - workspace root.
   * @param {string} key - alias, id, or name.
   * @returns {Promise<Record<string, any> | null>} ref, or null.
   */
  async function refForKey(cwd, key) {
    const { workspace, assets } = storesFor(cwd)
    const direct = await workspace.findRef(key)
    if (direct !== null) return direct
    const entries = await assets.list()
    const matches = entries.filter((entry) => entry.name === String(key).trim())
    if (matches.length !== 1) return null
    return workspace.findRef(String(matches[0].id))
  }

  /**
   * Validate a definition with current host facts.
   * @param {Record<string, any>} definition - flow definition.
   * @returns {Promise<{ok: boolean, errors: object[], warnings: string[]}>} validation.
   */
  async function validate(definition) {
    return validateFlow(definition, hostFacts())
  }

  /**
   * Build (or reuse) the lockfile a run pins.
   * @param {Record<string, any>} resolved - resolver output.
   * @returns {Promise<Record<string, any>>} lockfile.
   */
  async function lockfileFor(resolved) {
    if (resolved.lockfile !== null && resolved.lockfile !== undefined) return resolved.lockfile
    const capability = hosts.capability()
    const presets = hosts.presets()
    return buildLockfile({
      definition: resolved.definition,
      revision: Number.isInteger(resolved.revision) ? resolved.revision : 0,
      pluginVersion: PLUGIN_VERSION,
      capability,
      layerStatus: (id) => layerStatus(capability, id),
      presetStatus: async (id) => {
        if (presets === undefined || typeof presets.resolve !== 'function') return { ok: true }
        try {
          const record = await presets.resolve(id)
          if (record?.broken !== undefined) return { ok: false, broken: String(record.broken) }
          // The preset's plugin rows are part of what "this revision was
          // published against" means: a later preset edit changes a node's
          // tools even though the flow JSON did not change.
          let composition = null
          try {
            if (typeof presets.compositionInventory === 'function') {
              const inventory = await presets.compositionInventory()
              const entry = Array.isArray(inventory) ? inventory.find((candidate) => candidate?.id === id) : undefined
              if (Array.isArray(entry?.rows)) {
                composition = entry.rows.map((row) => ({ moduleName: String(row.moduleName ?? ''), enabled: row.enabled }))
              }
            }
          } catch {
            composition = null
          }
          return { ok: true, ...(composition === null ? {} : { composition }) }
        } catch (error) {
          return { ok: false, broken: String(error?.message ?? error) }
        }
      },
      now: now(),
    })
  }

  /**
   * Resolve one layer id from a run's lockfile.
   * @param {Record<string, any>} run - run record.
   * @param {string} layer - layer id.
   * @param {string} where - node id used in the error.
   * @returns {Record<string, any>} spawn agentOptions.
   * @throws {HnflowError} `model-layer-unknown`.
   */
  function routeForLayer(run, layer, where) {
    const pinned = run.lockfile?.models?.[layer]
    if (pinned === undefined || typeof pinned.provider !== 'string' || typeof pinned.model !== 'string') {
      throw new HnflowError('model-layer-unknown', `node ${where} pins model layer ${layer}, which could not be resolved when the revision was published`)
    }
    return agentOptionsOf(pinned)
  }

  /**
   * Resolve each node's spawn options from the pinned lockfile.
   * @param {Record<string, any>} definition - definition.
   * @param {Record<string, any>} lockfile - lockfile.
   * @returns {Promise<Record<string, Record<string, any>>>} node id → agentOptions.
   */
  async function routesOf(definition, lockfile) {
    /** @type {Record<string, Record<string, any>>} */
    const routes = {}
    for (const [id, node] of nodeIndex(definition)) {
      if (typeof node.model !== 'string') continue
      const pinned = lockfile?.models?.[node.model]
      if (pinned === undefined) {
        throw new HnflowError('model-layer-unknown', `node ${id} pins model layer ${node.model} but the lockfile has no route for it`)
      }
      if (typeof pinned.provider !== 'string' || typeof pinned.model !== 'string') {
        throw new HnflowError('model-layer-unknown', `node ${id} pins model layer ${node.model}, which could not be resolved when the revision was published`)
      }
      routes[id] = agentOptionsOf(pinned)
    }
    return routes
  }

  /**
   * Resolve the model route a conductor session should use.
   *
   * A conductor is created outside any UI session, so it has no session-level
   * model selection to inherit: without an explicit route its children cannot
   * start a model turn. Prefer the host's current default selection, then the
   * Capability default layer.
   * @returns {Record<string, any> | null} agent options, or null for the host default.
   */
  function conductorAgentOptions() {
    try {
      const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.()
      if (typeof selection?.provider === 'string' && typeof selection?.model === 'string') {
        return {
          provider: selection.provider,
          model: selection.model,
          ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}),
        }
      }
    } catch {
      // fall through to the layer default
    }
    const capability = hosts.capability()
    if (typeof capability?.defaultLayer === 'function' && typeof capability?.resolveLayer === 'function') {
      try {
        const layer = capability.resolveLayer(capability.defaultLayer())
        if (typeof layer?.provider === 'string' && typeof layer?.model === 'string') return agentOptionsOf(layer)
      } catch {
        // fall through to the host default
      }
    }
    return null
  }

  /**
   * Resolve the parent agent a run may spawn from.
   * @param {Record<string, any>} run - run record.
   * @returns {Promise<Record<string, any> | null>} host agent.
   */
  async function hostFor(run) {
    const agents = hosts.agents()
    if (agents === undefined || typeof agents.get !== 'function') return null
    if (typeof run.hostSessionId === 'string') {
      const live = agents.get(run.hostSessionId)
      if (live !== null && live !== undefined) return live
    }
    if (conductor === null && typeof agents.create === 'function') {
      conductor = (async () => {
        try {
          const options = conductorAgentOptions()
          if (process.env.HNFLOW_TRACE === '1') process.stderr.write(`[hnflow] conductor agentOptions: ${JSON.stringify(options)}\n`)
          conductorHandle = await agents.create({ sessionId: randomUUID(), ...(options === null ? {} : { agentOptions: options }) })
          return conductorHandle?.agent ?? null
        } catch (error) {
          logger.warn?.('hnflow: cannot create the conductor session; page-started runs stay unavailable: %o', error)
          return null
        }
      })()
    }
    const pending = conductor === null ? null : await conductor
    return pending ?? null
  }

  /**
   * Spawn one envelope-declaring child and interpret its answer.
   * @param {{
   *   run: Record<string, any>,
   *   node: Record<string, any>,
   *   host: Record<string, any>,
   *   prompt: string,
   *   schema: Record<string, any>,
   *   prior?: Record<string, any>[],
   * }} input - spawn input.
   * @returns {Promise<{kind: string, output?: any, gap?: any, diagnostic?: any, childId?: string}>} interpreted result.
   */
  async function spawnNode(input) {
    const { run, node, host, prompt, schema } = input
    const route = input.route ?? run.routes?.[node.id]
    const attempts = Number.isInteger(node.budget?.maxAttempts) && node.budget.maxAttempts > 0 ? node.budget.maxAttempts : config.maxAttempts
    const timeoutMs = Number.isFinite(node.budget?.timeoutMs) ? node.budget.timeoutMs : config.nodeTimeoutMs
    /** @type {Record<string, any> | null} */
    let last = null
    /** @type {Record<string, number> | null} */
    let lastUsage = null
    // Failures accumulate across attempts *and* across steps of the same node:
    // resending an unchanged brief is how a retry repeats the same mistake.
    const history = Array.isArray(input.prior) ? [...input.prior] : []
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (run.cancelRequested === true) return { kind: 'cancelled' }
      const attemptPrompt = history.length === 0 ? prompt : `${prompt}\n\n${renderRetrySection(history)}`
      /** @type {Record<string, any>} */
      let activation
      try {
        activation = await runner.spawn({
          parent: host,
          cwd: run.workspace,
          preset: node.preset,
          agentOptions: route,
          label: `${run.runId}/${node.id}#${attempt}`,
          prompt: attemptPrompt,
          outputSchema: schema,
        })
      } catch (error) {
        last = { code: String(error?.code ?? 'node-spawn-failed'), message: String(error?.message ?? error) }
        history.push({ attempt, ...last })
        continue
      }
      active.get(run.runId)?.add(activation)
      // The child session is disposed before `result` resolves, so usage must
      // be sampled while it is live; otherwise the run has no cost evidence.
      /** @type {Record<string, number> | null} */
      let observedUsage = null
      // Keep the live Session object itself: after disposal the store lookup is
      // gone, but the captured object still holds the final assistant event.
      const liveSession = hosts.sessions()?.get?.(activation.childId) ?? null
      const pollUsage = setInterval(() => {
        const sampled = usageOf(activation.childId)
        if (sampled !== null && sampled.calls > 0) observedUsage = sampled
      }, 1000)
      if (typeof pollUsage.unref === 'function') pollUsage.unref()
      const outcome = await withTimeout(activation.result, timeoutMs)
      clearInterval(pollUsage)
      active.get(run.runId)?.delete(activation)
      if (outcome.timedOut === true) {
        await activation.dispose().catch(() => {})
        last = { code: 'node-timeout', message: `node ${node.id} exceeded ${timeoutMs} ms` }
        history.push({ attempt, ...last })
        continue
      }
      const result = outcome.value
      const finalUsage = usageFromSession(liveSession)
      const usage = finalUsage !== null && finalUsage.calls > 0 ? finalUsage : (observedUsage ?? usageOf(result?.childId))
      const envelope = parseEnvelope(result?.structured)
      if (envelope.kind === 'done') {
        return { kind: 'done', output: envelope.output, evidence: envelope.evidence, notes: envelope.notes, childId: result.childId, usage }
      }
      if (envelope.kind === 'needs_human') {
        return { kind: 'needs_human', gap: envelope.gap, childId: result.childId, usage }
      }
      if (envelope.kind === 'failed') {
        last = envelope.error
        lastUsage = usage
        history.push({ attempt, code: String(envelope.error?.code ?? 'node-failed'), message: String(envelope.error?.message ?? ''), violations: envelope.error?.violations })
        continue
      }
      last = {
        code: result?.stopReason === 'completed' ? 'node-envelope-invalid' : 'node-failed',
        message: envelope.message ?? `stopReason=${String(result?.stopReason ?? 'unknown')}`,
      }
      history.push({ attempt, ...last })
      lastUsage = usage
    }
    return { kind: 'failed', diagnostic: last ?? { code: 'node-failed', message: `node ${node.id} failed` }, usage: lastUsage }
  }

  /**
   * Diagnostics from an earlier step of the same node.
   *
   * A node can be re-entered (gate rework, fallback, resume); without this the
   * child receives the same brief it already failed with.
   * @param {Record<string, any>} run - run record.
   * @param {Record<string, any>} node - node.
   * @returns {Record<string, any>[]} prior failures, oldest first.
   */
  function priorDiagnostics(run, node) {
    const state = nodeState(run, node.id)
    const attempts = Number(state.attempts ?? 0)
    const diagnostic = state.diagnostic
    if (diagnostic === undefined || diagnostic === null || attempts <= 1) return []
    return [
      {
        attempt: attempts - 1,
        code: String(diagnostic.code ?? 'node-failed'),
        message: String(diagnostic.message ?? ''),
        violations: diagnostic.violations,
      },
    ]
  }

  /**
   * Execute one agent node.
   * @param {Record<string, any>} flow - definition.
   * @param {Record<string, any>} run - run record.
   * @param {Record<string, any>} node - node.
   * @param {Record<string, any>} host - parent agent.
   * @returns {Promise<Record<string, any>>} node result.
   */
  async function executeAgent(flow, run, node, host) {
    const upstream = upstreamArtifacts(flow, run, node.id)
    let prompt = buildNodeBrief({ flow, node, run, upstream, outputSchema: node.output })
    if (node.humanDelivery !== undefined) {
      prompt += `\n\n## 人的交付物（本次继续使用）\n\n\`\`\`json\n${JSON.stringify(node.humanDelivery, null, 2).slice(0, 8000)}\n\`\`\``
    }
    const result = await spawnNode({ run, node, host, prompt, schema: envelopeSchema(node.output), prior: priorDiagnostics(run, node) })
    if (result.kind === 'needs_human') {
      if (node.allowHuman !== true) {
        return { status: 'failed', diagnostic: { code: 'human-not-allowed', message: `node ${node.id} reported a human gap but does not declare allowHuman` }, usage: result.usage }
      }
      return { status: 'human', gap: result.gap, childSessionId: result.childId, usage: result.usage }
    }
    if (result.kind === 'failed') return { status: 'failed', diagnostic: result.diagnostic, childSessionId: result.childId, usage: result.usage }
    if (result.kind === 'cancelled') return { status: 'failed', diagnostic: { code: 'cancelled', message: 'the run was cancelled' } }
    const checked = validateValue(result.output, node.output)
    if (!checked.ok) {
      return {
        status: 'failed',
        diagnostic: { code: 'contract-unsatisfied', message: 'the output does not satisfy the node contract', violations: checked.violations },
        childSessionId: result.childId,
        usage: result.usage,
      }
    }
    return { status: 'done', output: result.output, childSessionId: result.childId, evidence: result.evidence, usage: result.usage }
  }

  /**
   * Execute one judge node.
   * @param {Record<string, any>} flow - definition.
   * @param {Record<string, any>} run - run record.
   * @param {Record<string, any>} node - node.
   * @param {Record<string, any>} host - parent agent.
   * @returns {Promise<Record<string, any>>} node result.
   */
  async function executeJudge(flow, run, node, host) {
    const upstream = upstreamArtifacts(flow, run, node.id)
    const criteria = typeof node.criteria === 'string' ? node.criteria : ''
    const prompt = [
      `你是独立裁决者（judge \`${node.id}\`），不参与生产。`,
      '',
      '## 裁决标准',
      criteria.length > 0 ? criteria : '根据上游产物与流程契约判断是否可接受。',
      '',
      '## 上游产物',
      ...upstream.map((artifact) => `### \`${artifact.from}\`\n\`\`\`json\n${JSON.stringify(artifact.value ?? null, null, 2).slice(0, 8000)}\n\`\`\``),
      '',
      '提交 `{status:"done", output:{verdict:"accept"|"reject"|"needs_more", reasons:[...], conditions:[...]}}`。',
      '不要向用户提问，不要委派。',
    ].join('\n')
    const result = await spawnNode({ run, node, host, prompt, schema: judgeEnvelopeSchema() })
    if (result.kind === 'failed') return { status: 'failed', diagnostic: result.diagnostic, childSessionId: result.childId, usage: result.usage }
    if (result.kind !== 'done') return { status: 'inconclusive', diagnostic: { code: 'judge-inconclusive', message: 'the judge did not return a verdict' }, childSessionId: result.childId, usage: result.usage }
    const verdict = parseVerdict(result.output)
    if (verdict === null) return { status: 'inconclusive', diagnostic: { code: 'judge-inconclusive', message: 'the verdict is malformed' }, childSessionId: result.childId, usage: result.usage }
    // A reject is a **valid verdict**, not a node failure: outgoing edges route
    // on `when.verdict` and the run's success is decided downstream.
    return { status: 'done', output: result.output, verdict: verdict.verdict, childSessionId: result.childId, usage: result.usage }
  }

  /**
   * Execute one merge node: a deterministic, declarative join.
   * @param {Record<string, any>} run - run record.
   * @param {Record<string, any>} node - node.
   * @returns {Record<string, any>} node result.
   */
  function executeMerge(run, node) {
    /** @type {{from: string, value: any}[]} */
    const values = []
    for (const sourceId of Array.isArray(node.from) ? node.from : []) {
      const state = run.nodes?.[sourceId]
      // A skipped branch is absent, not broken: that is how a gate's
      // conditional branches converge on one merge. A failed branch still
      // fails loud — the run is already failing and the merge must not hide it.
      if (state?.status === 'skipped') continue
      if (state?.status !== 'done') {
        return { status: 'failed', diagnostic: { code: 'merge-source-missing', message: `merge ${node.id}: ${sourceId} has no completed output` } }
      }
      values.push({ from: sourceId, value: state.output })
    }
    /** @type {Record<string, any>} */
    let merged = {}
    const constants = node.set !== null && typeof node.set === 'object' && !Array.isArray(node.set) ? node.set : null
    if (values.length === 0) {
      if (constants === null || Object.keys(constants).length === 0) {
        return { status: 'failed', diagnostic: { code: 'merge-source-missing', message: `merge ${node.id}: every source was skipped` } }
      }
      merged = { ...constants }
    } else if (values.length === 1) merged = { ...(constants ?? {}), ...(values[0].value !== null && typeof values[0].value === 'object' && !Array.isArray(values[0].value) ? values[0].value : {}) }
    else {
      merged = { ...(constants ?? {}) }
      for (const entry of values) {
        if (entry.value !== null && typeof entry.value === 'object' && !Array.isArray(entry.value)) Object.assign(merged, entry.value)
        else merged[entry.from] = entry.value
      }
    }
    if (node.map !== null && typeof node.map === 'object' && !Array.isArray(node.map)) {
      /** @type {Record<string, any>} */
      const mapped = {}
      for (const [target, source] of Object.entries(node.map)) {
        const [from, ...rest] = String(source).split('.')
        const entry = values.find((candidate) => candidate.from === from)
        let value = entry?.value
        for (const part of rest) value = value === null || value === undefined ? undefined : value[part]
        mapped[target] = value
      }
      merged = mapped
    }
    const checked = validateValue(merged, node.output)
    if (!checked.ok) {
      return { status: 'failed', diagnostic: { code: 'contract-unsatisfied', message: `merge ${node.id} produced an invalid value`, violations: checked.violations } }
    }
    return { status: 'done', output: merged }
  }

  /**
   * Execute one verify node.
   * @param {Record<string, any>} flow - definition.
   * @param {Record<string, any>} run - run record.
   * @param {Record<string, any>} node - node.
   * @param {Record<string, any>} host - parent agent.
   * @returns {Promise<Record<string, any>>} node result.
   */
  async function executeVerify(flow, run, node, host) {
    const requestNode = nodeIndex(flow).get(node.against)
    const state = run.nodes?.[node.against]
    if (requestNode === undefined || state?.status !== 'done') {
      return { status: 'failed', diagnostic: { code: 'verify-target-missing', message: `verify ${node.id}: request ${node.against} has no accepted delivery` } }
    }
    const delivery = state.output
    const checks = Array.isArray(node.checks) ? node.checks : ['schema']
    /** @type {object[]} */
    const violations = []
    if (checks.includes('schema')) {
      const checked = validateValue(delivery, requestNode.deliverable)
      if (!checked.ok) violations.push(...checked.violations)
    }
    if (violations.length > 0) {
      return { status: 'rejected', diagnostic: { code: 'delivery-rejected', message: 'the delivery fails its contract', violations } }
    }
    if (checks.includes('judge')) {
      const judge = node.judge ?? {}
      const judgeRoute = typeof judge.model === 'string' ? routeForLayer(run, judge.model, `${node.id}:judge`) : undefined
      const prompt = buildJudgeBrief({ flow, node, run, requestNode, delivery })
      const result = await spawnNode({
        run,
        node: { ...judge, id: `${node.id}:judge`, budget: node.budget, preset: judge.preset },
        host,
        prompt,
        schema: judgeEnvelopeSchema(),
        route: judgeRoute,
      })
      if (result.kind !== 'done') {
        return { status: 'inconclusive', diagnostic: { code: 'judge-inconclusive', message: 'the judge did not return a verdict', childSessionId: result.childId }, childSessionId: result.childId, usage: result.usage }
      }
      const verdict = parseVerdict(result.output)
      if (verdict === null) {
        return { status: 'inconclusive', diagnostic: { code: 'judge-inconclusive', message: 'the verdict is malformed' }, childSessionId: result.childId, usage: result.usage }
      }
      if (verdict.verdict === 'reject') {
        return { status: 'rejected', diagnostic: { code: 'judge-reject', message: verdict.reasons.join('; ') || 'the judge did not accept the delivery', verdict }, verdict, childSessionId: result.childId, usage: result.usage }
      }
      if (verdict.verdict === 'needs_more') {
        return {
          status: 'inconclusive',
          diagnostic: { code: 'judge-needs-more', message: verdict.reasons.join('; ') || 'the judge needs more before deciding', verdict },
          verdict,
          childSessionId: result.childId,
          usage: result.usage,
        }
      }
      return { status: 'done', output: { accepted: true, violations: [], judged: true }, childSessionId: result.childId, verdict: 'accept', usage: result.usage }
    }
    return { status: 'done', output: { accepted: true, violations: [], judged: false } }
  }

  /**
   * Execute one node of any primitive.
   * @param {Record<string, any>} flow - definition.
   * @param {Record<string, any>} run - run record.
   * @param {Record<string, any>} node - node.
   * @param {Record<string, any>} host - parent agent.
   * @returns {Promise<Record<string, any>>} result.
   */
  async function executeNode(flow, run, node, host) {
    switch (node.type) {
      case 'agent':
        return executeAgent(flow, run, node, host)
      case 'judge':
        return executeJudge(flow, run, node, host)
      case 'merge':
        return executeMerge(run, node)
      case 'verify':
        return executeVerify(flow, run, node, host)
      case 'gate': {
        const snapshot = Object.fromEntries(upstreamArtifacts(flow, run, node.id).map((artifact) => [artifact.from, artifact.value]))
        const pending = openPending(flow, run, node, createGatePending(node, { now: now(), snapshot }), snapshot)
        return { status: 'waiting', pending }
      }
      case 'request': {
        const pending = openPending(flow, run, node, createRequestPending(node, { now: now() }))
        return { status: 'waiting', pending }
      }
      default: {
        // Not one of the six built-ins: only a registered deterministic kind
        // may run it. An unknown type stays a validation-grade failure.
        const kind = kinds.get(node.type)
        if (kind === undefined) {
          return { status: 'failed', diagnostic: { code: 'node-type-invalid', message: `unsupported node type ${String(node.type)}` } }
        }
        const upstream = upstreamArtifacts(flow, run, node.id)
        try {
          const normalized = normalizeKindResult(await kind.run({ flow, run, node, upstream, input: run.input ?? {} }), kind.id)
          if (normalized.status === 'failed') return { status: 'failed', diagnostic: normalized.diagnostic }
          const checked = validateValue(normalized.output, node.output)
          if (!checked.ok) {
            return {
              status: 'failed',
              diagnostic: { code: 'contract-unsatisfied', message: `node kind ${kind.id} returned an output that does not satisfy the node contract`, violations: checked.violations },
            }
          }
          return { status: 'done', output: normalized.output }
        } catch (error) {
          return { status: 'failed', diagnostic: { code: String(error?.code ?? 'node-failed'), message: String(error?.message ?? error) } }
        }
      }
    }
  }

  /**
   * Offer a gate on every delivery channel, in addition to the inbox.
   *
   * Channels are convenience, never the source of truth: the pending record is
   * already durable, so a missing answerer, an unrendered card or a failed
   * third-party push only means the decision happens on the page instead.
   * @param {Record<string, any>} run - run record.
   * @param {Record<string, any>} node - gate node.
   * @param {Record<string, any>} pending - pending record.
   * @param {Record<string, any>} host - live root agent.
   * @returns {Promise<void>} resolves once the card was attempted.
   */
  async function askGate(run, node, pending, host) {
    if (typeof hosts.questions()?.ask !== 'function' || pending.asked === 'card') return
    pending.asked = 'card'
    const outcome = await channels.send('card', { run, node, pending, host })
    if (!outcome.ok) {
      // The inbox is the effective channel from here on.
      pending.askedVia = 'inbox'
      pending.askError = outcome.error ?? outcome.code
    }
  }

  /**
   * Render the gate as a native question card and submit its answer.
   *
   * The decision is submitted after the current step settles its own chain (no
   * re-entrant deadlock).
   * @param {Record<string, any>} run - run record.
   * @param {Record<string, any>} node - gate node.
   * @param {Record<string, any>} pending - pending record.
   * @param {Record<string, any>} host - live root agent.
   * @returns {Promise<void>} resolves when the card settles.
   */
  async function askCard(run, node, pending, host) {
    const questions = hosts.questions()
    if (typeof questions?.ask !== 'function') return
    pending.askedVia = 'card'
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10 * 60_000)
    if (typeof timer.unref === 'function') timer.unref()
    void (async () => {
      try {
        const answers = await questions.ask({ agent: host, questions: [gateQuestion(node, pending)], signal: controller.signal })
        const answer = Array.isArray(answers) ? answers[0] : undefined
        const selected = Array.isArray(answer?.selected) ? answer.selected[0] : ''
        const custom = typeof answer?.custom === 'string' ? answer.custom.trim() : ''
        const decision = selected === 'approve' ? 'approved' : selected === 'reject' ? 'rejected' : selected === 'modify' ? 'modified' : null
        if (decision === null) return
        const reason = custom.length > 0 ? custom : decision === 'rejected' ? '通过问题卡拒绝' : ''
        if (decision === 'rejected' && reason.length === 0) return
        void decide({ runId: run.runId, gateId: pending.id, decision, reason, revision: pending.revision }).catch((error) => {
          logger.warn?.('hnflow: the gate card decision was refused: %o', error)
        })
      } catch (error) {
        // The card is a convenience, never the source of truth: record that it
        // failed and leave the inbox as the effective channel.
        pending.askedVia = 'inbox'
        pending.askError = String(error?.message ?? error)
        logger.info?.('hnflow: the gate card was not answered; the inbox remains authoritative: %o', error)
      } finally {
        clearTimeout(timer)
      }
    })()
  }

  /**
   * Ask an independent judge whether a rejected delivery can still be accepted
   * after its attempt budget ran out (`onReject.kind: 'arbitrate'`).
   *
   * The judge sees the contract, the rejection evidence and the delivery — not
   * the producer's history. Accepting records the conditions in the audit and
   * marks the artifact arbitrated; anything else still fails.
   * @param {Record<string, any>} flow - definition.
   * @param {Record<string, any>} run - run record.
   * @param {Record<string, any>} pending - request pending record.
   * @param {Record<string, any>} rejection - the rejected verify result.
   * @param {Record<string, any>} host - live parent agent.
   * @returns {Promise<{accepted: boolean, verdict?: Record<string, any>, diagnostic?: Record<string, any>, usage?: Record<string, number> | null}>} outcome.
   */
  async function arbitrateDelivery(flow, run, pending, rejection, host) {
    const requestNode = findNode(flow, pending.nodeId)
    const policy = pending.rejectPolicy ?? requestNode?.onReject ?? {}
    const judge = policy.judge !== null && typeof policy.judge === 'object' ? policy.judge : {}
    const preset = typeof judge.preset === 'string' ? judge.preset : typeof requestNode?.judge?.preset === 'string' ? requestNode.judge.preset : 'standard'
    const route = typeof judge.model === 'string' ? routeForLayer(run, judge.model, `${pending.nodeId}:arbitrate`) : undefined
    const prompt = [
      `你是交付仲裁者（request \`${pending.nodeId}\`）。生产者与验收者已经发生分歧，你只判断“部分满足是否可接受”。`,
      '',
      '## 为什么需要人',
      String(requestNode?.whyHuman ?? pending.whyHuman ?? ''),
      '',
      '## 交付契约',
      '```json',
      JSON.stringify(requestNode?.deliverable ?? pending.deliverable ?? {}, null, 2).slice(0, 4000),
      '```',
      '',
      '## 人的交付',
      '```json',
      JSON.stringify(pending.delivery?.payload ?? null, null, 2).slice(0, 8000),
      '```',
      '',
      '## 拒绝证据',
      '```json',
      JSON.stringify({ code: rejection.diagnostic?.code, message: rejection.diagnostic?.message, violations: rejection.diagnostic?.violations ?? [], verdict: rejection.diagnostic?.verdict ?? null }, null, 2).slice(0, 4000),
      '```',
      '',
      '只输出 `{status:"done", output:{verdict:"accept"|"reject"|"needs_more", reasons:[...], conditions:[...]}}`。',
      'accept 表示“在给出的条件下可以接受”，conditions 必须写清限制；不要向用户提问，不要委派。',
    ].join('\n')
    const result = await spawnNode({
      run,
      node: { ...judge, id: `${pending.nodeId}:arbitrate`, preset, budget: requestNode?.budget },
      host,
      prompt,
      schema: judgeEnvelopeSchema(),
      route,
    })
    if (result.kind !== 'done') return { accepted: false, usage: result.usage }
    const verdict = parseVerdict(result.output)
    if (verdict === null || verdict.verdict !== 'accept') return { accepted: false, verdict: verdict ?? undefined, usage: result.usage }
    return { accepted: true, verdict, usage: result.usage }
  }

  /**
   * Fold one node result into the run record.
   * @param {Record<string, any>} flow - definition.
   * @param {Record<string, any>} run - run record.
   * @param {string} id - node id.
   * @param {Record<string, any>} result - execution result.
   * @param {Record<string, any>} host - live parent agent (arbitration needs it).
   * @returns {Promise<void>} resolves once folded.
   */
  async function applyNodeResult(flow, run, id, result, host) {
    const state = nodeState(run, id)
    const node = findNode(flow, id)
    const base = { ...state, endedAt: now().toISOString() }
    run.usage = addUsage(run.usage, result.usage ?? null)
    switch (result.status) {
      case 'done': {
        const degraded = typeof state.degradedFrom === 'string'
        const artifact = registerArtifact(run, node, {
          degraded,
          degradedReason: degraded ? `fallback from ${state.degradedFrom}` : undefined,
          ...(result.verdict === 'accept' ? { accepted: true } : {}),
        })
        run.nodes[id] = {
          ...base,
          status: 'done',
          output: result.output,
          childSessionId: result.childSessionId,
          verdict: result.verdict,
          ...(artifact === null ? {} : { artifactId: artifact.artifactId }),
          ...(result.usage === null || result.usage === undefined ? {} : { usage: result.usage }),
        }
        return
      }
      case 'waiting':
        run.nodes[id] = { ...base, status: 'waiting', pendingId: result.pending.id }
        return
      case 'human': {
        const pending = openPending(
          flow,
          run,
          node,
          createRequestPending(
            { id, deliverable: result.gap.deliverable, whyHuman: result.gap.whyHuman, onExpire: 'remind' },
            { now: now(), gap: result.gap },
          ),
        )
        run.nodes[id] = { ...base, status: 'waiting', childSessionId: result.childSessionId, pendingId: pending.id }
        return
      }
      case 'rejected': {
        const requestId = node?.against
        const requestNode = findNode(flow, requestId)
        const pending = run.pending.find((entry) => entry.kind === 'request' && entry.nodeId === requestId)
        if (pending !== undefined) {
          pending.attempts = Number(pending.attempts ?? 0) + 1
          pending.lastViolations = result.diagnostic?.violations ?? []
          pending.lastDiagnostic = result.diagnostic ?? null
          // The rejection policy lives on the request (who is asked), with the
          // verify node's declaration as a per-check override.
          const policy = requestNode?.onReject ?? node?.onReject
          pending.rejectPolicy = policy
          const next = rejectionStep({ onReject: policy }, pending.attempts)
          if (next === 'return') {
            delete pending.delivery
            delete pending.decision
            delete pending.deliveryId
            run.nodes[pending.nodeId] = { ...nodeState(run, pending.nodeId), status: 'waiting' }
            run.nodes[id] = { ...base, status: 'pending', diagnostic: result.diagnostic }
            return
          }
          if (next === 'arbitrate') {
            const outcome = await arbitrateDelivery(flow, run, pending, result, host)
            run.usage = addUsage(run.usage, outcome.usage ?? null)
            if (outcome.accepted) {
              pending.arbitrated = true
              pending.arbitration = outcome.verdict
              pending.delivery = { ...(pending.delivery ?? {}), accepted: true, arbitrated: true, conditions: outcome.verdict.conditions ?? [] }
              const requestState = nodeState(run, pending.nodeId)
              run.nodes[pending.nodeId] = { ...requestState, status: 'done', output: pending.delivery.payload }
              const artifact = run.artifacts?.[requestState.artifactId]
              if (artifact !== undefined) artifact.accepted = true
              const verifyArtifact = registerArtifact(run, node, { accepted: true })
              run.nodes[id] = {
                ...base,
                status: 'done',
                output: { accepted: true, violations: pending.lastViolations, judged: true, arbitrated: true, conditions: outcome.verdict.conditions ?? [] },
                verdict: 'accept',
                ...(verifyArtifact === null ? {} : { artifactId: verifyArtifact.artifactId }),
              }
              run.audit = Array.isArray(run.audit) ? run.audit : []
              run.audit.push({
                at: now().toISOString(),
                kind: 'arbitration',
                pendingId: pending.id,
                nodeId: pending.nodeId,
                verdict: outcome.verdict ?? null,
                decidedBy: 'judge',
              })
              return
            }
            pending.arbitration = { verdict: outcome.verdict ?? null, accepted: false }
            run.nodes[id] = {
              ...base,
              status: 'failed',
              diagnostic: { code: 'arbitration-rejected', message: outcome.verdict?.reasons?.join('; ') || 'the arbitration did not accept the delivery', verdict: outcome.verdict },
            }
            run.nodes[pending.nodeId] = {
              ...nodeState(run, pending.nodeId),
              status: 'failed',
              diagnostic: { code: 'delivery-rejected', message: 'the delivery was rejected after arbitration' },
            }
            return
          }
          if (next === 'fallback') activateFallbacks(flow, run, pending.nodeId, { code: 'delivery-rejected', message: result.diagnostic?.message })
          run.nodes[id] = { ...base, status: 'failed', diagnostic: result.diagnostic }
          run.nodes[pending.nodeId] = {
            ...nodeState(run, pending.nodeId),
            status: 'failed',
            diagnostic: { code: 'delivery-rejected', message: 'the delivery was rejected after the attempt budget' },
          }
          return
        }
        run.nodes[id] = { ...base, status: 'failed', diagnostic: result.diagnostic }
        return
      }
      case 'inconclusive': {
        // A verify/judge that cannot decide is not a silent failure: by
        // default it parks on a gate, and the human sees the verdict, the
        // violations and the diagnostics before deciding whether to accept it.
        const gateable = (node?.type === 'verify' || node?.type === 'judge') && node.onInconclusive !== 'fail'
        if (gateable) {
          const snapshot = {
            verdict: result.verdict ?? null,
            diagnostic: result.diagnostic ?? null,
            violations: result.diagnostic?.violations ?? [],
          }
          const pending = openPending(
            flow,
            run,
            node,
            createGatePending(
              { id, title: `验收不确定：${id}`, detail: '验收无法给出明确结论，请裁决是否接受当前交付。' },
              { now: now(), snapshot },
            ),
            snapshot,
          )
          pending.origin = 'inconclusive'
          pending.verdict = result.verdict ?? null
          run.nodes[id] = { ...base, status: 'waiting', pendingId: pending.id }
          return
        }
        run.nodes[id] = { ...base, status: 'failed', diagnostic: result.diagnostic }
        activateFallbacks(flow, run, id, { code: result.diagnostic?.code ?? 'inconclusive', message: result.diagnostic?.message })
        return
      }
      default:
        run.nodes[id] = { ...base, status: 'failed', diagnostic: result.diagnostic ?? { code: 'node-failed', message: 'the node failed' } }
        if (result.diagnostic?.code !== 'cancelled') {
          activateFallbacks(flow, run, id, { code: result.diagnostic?.code ?? 'node-failed', message: result.diagnostic?.message })
        }
    }
  }

  /**
   * Find a node by id.
   * @param {Record<string, any>} flow - definition.
   * @param {string} id - node id.
   * @returns {Record<string, any> | undefined} node.
   */
  function findNode(flow, id) {
    return nodeIndex(flow).get(id)
  }

  /**
   * Record the effects a finished run owes.
   *
   * Written before they are delivered: the pass picks them up later, so a crash
   * between "the run is terminal" and "the owner knows" cannot lose the notice.
   * @param {Record<string, any>} run - terminal run.
   * @returns {Promise<void>} resolves once recorded.
   */
  async function recordRunEffects(run) {
    const status = String(run.status)
    try {
      await outbox.enqueue({
        kind: 'notice',
        key: `notice:${run.runId}:${status}`,
        runId: run.runId,
        payload: { runId: run.runId, flowId: run.flowId, flowName: run.flowName, status, message: runHealth(run, { now: now() }).message },
      })
      if (status === 'succeeded') {
        await outbox.enqueue({
          kind: 'trigger',
          key: `run-completed:${run.runId}`,
          runId: run.runId,
          payload: { runId: run.runId, flowId: run.flowId, flowName: run.flowName, chain: Array.isArray(run.chain) ? run.chain : [] },
        })
      }
    } catch (error) {
      logger.warn?.('hnflow: cannot record the run effects: %o', error)
    }
  }

  /**
   * Advance one run as far as it can go.
   * @param {string} runId - run identity.
   * @returns {Promise<Record<string, any> | null>} the run after the step.
   */
  async function step(runId) {
    const run = await store.getRun(runId)
    if (run === null || TERMINAL_RUN.has(run.status) || run.status === 'interrupted') return run
    const flow = await flowOf(run)
    /** @type {Record<string, any> | null} */
    let host = null
    for (;;) {
      if (disposed) return run
      if (run.cancelRequested === true) {
        run.status = 'cancelled'
        run.endedAt = now().toISOString()
        run.updatedAt = run.endedAt
        run.error = { code: 'cancelled', message: 'the run was cancelled' }
        await store.putRun(run)
        await recordRunEffects(run)
        return run
      }
      const budget = Number(config.runBudgetMs ?? 0)
      const startedMs = Date.parse(String(run.startedAt ?? run.createdAt ?? ''))
      if (budget > 0 && Number.isFinite(startedMs) && now().getTime() - startedMs > budget) {
        const live = active.get(run.runId)
        if (live !== undefined) {
          for (const activation of live) await activation.dispose().catch(() => {})
        }
        run.status = 'failed'
        run.endedAt = now().toISOString()
        run.updatedAt = run.endedAt
        run.error = { code: 'run-budget-exceeded', message: `the run exceeded its ${Math.round(budget / 1000)}s budget` }
        await store.putRun(run)
        await recordRunEffects(run)
        return run
      }
      run.revisionCounter = Number(run.revisionCounter ?? 0) + 1
      run.updatedAt = now().toISOString()
      // Any advance invalidates a decision read before it: open human work
      // carries the current revision so a stale page submission is refused.
      for (const pending of run.pending) {
        if (pending.decision === undefined && pending.delivery === undefined) pending.revision = run.revisionCounter
      }
      settle(flow, run)
      const pendingOpen = run.pending.some((entry) => entry.decision === undefined && entry.delivery === undefined)
      if (pendingOpen) {
        run.status = 'waiting_human'
        await store.putRun(run)
        return run
      }
      const ready = runnableNodes(flow, run, config.maxParallel)
      if (ready.length === 0) {
        const status = impliedStatus(flow, run)
        run.status = status
        if (TERMINAL_RUN.has(status)) {
          run.endedAt = now().toISOString()
          if (status === 'failed') {
            const failed = Object.entries(run.nodes).filter(([, state]) => state.status === 'failed' || state.status === 'blocked')
            run.error = {
              code: 'run-failed',
              message: `nodes did not complete: ${failed.map(([id, state]) => `${id} (${state.diagnostic?.code ?? state.status})`).join(', ') || 'unknown'}`,
              nodes: failed.map(([id, state]) => ({ nodeId: id, code: state.diagnostic?.code ?? state.status })),
            }
          }
        }
        await store.putRun(run)
        if (TERMINAL_RUN.has(status)) await recordRunEffects(run)
        return run
      }
      if (host === null) {
        host = await hostFor(run)
        if (host === null) {
          run.status = 'interrupted'
          run.error = { code: 'host-unavailable', message: 'no live session or conductor can parent this run' }
          await store.putRun(run)
          return run
        }
      }
      for (const id of ready) {
        run.nodes[id] = {
          ...nodeState(run, id),
          status: 'running',
          startedAt: now().toISOString(),
          attempts: Number(nodeState(run, id).attempts ?? 0) + 1,
        }
      }
      await store.putRun(run)
      const results = await Promise.all(
        ready.map(async (id) => {
          try {
            return { id, result: await executeNode(flow, run, nodeIndex(flow).get(id), host) }
          } catch (error) {
            return { id, result: { status: 'failed', diagnostic: { code: String(error?.code ?? 'node-failed'), message: String(error?.message ?? error) } } }
          }
        }),
      )
      for (const { id, result } of results) await applyNodeResult(flow, run, id, result, host)
      for (const pending of run.pending) {
        if (pending.kind !== 'gate' || pending.decision !== undefined || pending.asked !== undefined) continue
        const node = nodeIndex(flow).get(pending.nodeId)
        if (node !== undefined) askGate(run, node, pending, host)
      }
      await store.putRun(run)
    }
  }

  /**
   * Start a fresh run.
   * @param {{cwd: string, key: string, input?: Record<string, any>, hostSessionId?: string, trigger?: Record<string, any>}} input - start input.
   * @returns {Promise<{runId: string, status: string, settled: Promise<Record<string, any> | null>}>} started run.
   */
  async function run(input) {
    await ready()
    requireCapability()
    const resolved = await resolveGroupFlow(input.cwd, input.key)
    const validation = await validate(resolved.definition)
    if (!validation.ok) {
      throw new HnflowError('flow-invalid', `the flow does not pass validation: ${validation.errors[0].message}`, { errors: validation.errors })
    }
    const lockfile = await lockfileFor(resolved)
    const problems = lockfileProblems(resolved.lockfile, { pluginVersion: PLUGIN_VERSION, capability: hosts.capability() })
    if (resolved.lockfile !== null && resolved.lockfile !== undefined && !problems.ok) {
      throw new HnflowError('lockfile-mismatch', problems.reasons.join('; '))
    }
    const inputCheck = validateValue(input.input ?? {}, resolved.definition.input ?? { type: 'object' })
    if (!inputCheck.ok) {
      throw new HnflowError('input-invalid', `the start input does not satisfy the flow input: ${inputCheck.violations[0].path} expects ${inputCheck.violations[0].expected}`, {
        violations: inputCheck.violations,
      })
    }
    const routes = await routesOf(resolved.definition, lockfile)
    const runId = `run-${randomUUID().replace(/-/gu, '').slice(0, 16)}`
    const startedAt = now().toISOString()
    /** @type {Record<string, any>} */
    const record = {
      runId,
      flowId: resolved.flowId,
      flowName: resolved.flowName || resolved.definition?.flow?.name || resolved.key,
      key: resolved.key,
      group: resolved.group ?? null,
      revision: Number.isInteger(resolved.revision) ? resolved.revision : null,
      source: resolved.source,
      // Self-contained: a draft override is executable even though it has no
      // published revision, and a later library edit cannot change this run.
      definition: resolved.definition,
      contentHash: contentHash(resolved.definition),
      lockfile,
      routes,
      workspace: String(input.cwd),
      hostSessionId: typeof input.hostSessionId === 'string' ? input.hostSessionId : null,
      status: 'running',
      input: input.input ?? {},
      createdAt: startedAt,
      startedAt,
      updatedAt: startedAt,
      endedAt: null,
      error: null,
      // A trigger-started run records what woke it, and the chain that led here
      // so a run-completed trigger cannot loop forever.
      trigger: input.trigger === undefined ? null : input.trigger,
      chain: Array.isArray(input.trigger?.chain) ? input.trigger.chain : [],
      recovery: null,
      nodes: Object.fromEntries([...nodeIndex(resolved.definition).keys()].map((id) => [id, { status: 'pending', attempts: 0 }])),
      pending: [],
      fallbacks: [],
      degradations: [],
      artifactRevisions: [],
      artifacts: {},
      usage: null,
      audit: [],
      warnings: problems.warnings,
      cancelRequested: false,
      revisionCounter: 0,
    }
    await store.putRun(record)
    knownWorkspaces.add(String(input.cwd))
    active.set(runId, new Set())
    const settled = enqueue(runId, () => step(runId))
    return { runId, status: 'running', settled }
  }

  /**
   * Explicitly resume a run that stopped.
   * @param {string} runId - run identity.
   * @returns {Promise<{runId: string, status: string, settled: Promise<Record<string, any> | null>}>} resume result.
   */
  async function resume(runId) {
    const record = await enqueue(runId, async () => {
      const current = await requireRun(runId)
      if (TERMINAL_RUN.has(current.status)) throw new HnflowError('run-terminal', `run ${runId} already ended as ${current.status}`)
      if (current.status === 'interrupted') {
        for (const [id, state] of Object.entries(current.nodes)) {
          if (state.status === 'running') current.nodes[id] = { ...state, status: 'pending' }
        }
      }
      current.status = 'running'
      current.error = null
      await store.putRun(current)
      return current
    })
    active.set(runId, new Set())
    const settled = enqueue(runId, () => step(runId))
    return { runId: record.runId, status: 'running', settled }
  }

  /**
   * Cancel a run cooperatively.
   * @param {string} runId - run identity.
   * @returns {Promise<{runId: string, status: string}>} result.
   */
  async function cancel(runId) {
    const record = await requireRun(runId)
    if (TERMINAL_RUN.has(record.status)) return { runId, status: record.status }
    record.cancelRequested = true
    await store.putRun(record)
    for (const activation of active.get(runId) ?? []) {
      await activation.dispose().catch(() => {})
    }
    if (Object.values(record.nodes).every((state) => state.status !== 'running')) {
      await enqueue(runId, () => step(runId)).catch(() => undefined)
    }
    return { runId, status: 'cancelled' }
  }

  /**
   * Decide a pending gate.
   * @param {{runId: string, gateId: string, decision: string, reason?: string, revision?: number}} input - decision.
   * @returns {Promise<{runId: string, status: string, settled: Promise<Record<string, any> | null>}>} result.
   */
  async function decide(input) {
    const record = await enqueue(input.runId, async () => {
      const current = await requireRun(input.runId)
      const pending = current.pending.find((entry) => entry.id === input.gateId)
      if (pending === undefined || pending.kind !== 'gate') throw new HnflowError('gate-missing', `no gate ${input.gateId} in run ${input.runId}`)
      const outcome = decideGate(pending, input, { now: now(), runRevision: pending.revision })
      if (!outcome.ok) throw new HnflowError(outcome.code, outcome.message)
      if (input.artifact !== undefined) {
        if (outcome.decision.decision !== 'modified') {
          throw new HnflowError('invalid-decision', 'a modified artifact is only accepted with the "modified" decision')
        }
        try {
          JSON.stringify(input.artifact)
        } catch {
          throw new HnflowError('payload-invalid', 'the modified artifact must be JSON-serializable')
        }
        outcome.decision.artifact = input.artifact
      }
      const flow = await flowOf(current)
      const nodeDef = findNode(flow, pending.nodeId)
      pending.decision = outcome.decision
      pending.decidedBy = 'owner'
      pending.decidedAt = outcome.decision.decidedAt
      const rejected = outcome.decision.decision === 'rejected'
      const decidedAt = now().toISOString()
      const node = nodeState(current, pending.nodeId)
      const audit = {
        at: decidedAt,
        pendingId: pending.id,
        nodeId: pending.nodeId,
        flowRevision: pending.flowRevision ?? null,
        contentHash: pending.contentHash ?? null,
        upstreamHash: pending.upstreamHash ?? null,
        askedVia: pending.askedVia ?? 'inbox',
        consumerNodeIds: pending.consumerNodeIds ?? [],
        decision: outcome.decision,
        decidedBy: 'owner',
      }
      if (pending.origin === 'inconclusive' && (nodeDef?.type === 'verify' || nodeDef?.type === 'judge')) {
        // The gate is arbitrating an inconclusive verdict: approving accepts
        // the result with the doubt recorded, rejecting makes it a clear
        // `reject` verdict for a judge (so `when.verdict` edges still route).
        const artifact = rejected ? null : registerArtifact(current, nodeDef, { accepted: true })
        if (nodeDef.type === 'judge') {
          const verdict = rejected ? 'reject' : 'accept'
          current.nodes[pending.nodeId] = {
            ...node,
            status: 'done',
            endedAt: decidedAt,
            output: { verdict, reasons: outcome.decision.reason.length > 0 ? [outcome.decision.reason] : [], conditions: [] },
            verdict,
            ...(artifact === null ? {} : { artifactId: artifact.artifactId }),
          }
        } else {
          current.nodes[pending.nodeId] = rejected
            ? {
                ...node,
                status: 'failed',
                endedAt: decidedAt,
                diagnostic: {
                  code: 'inconclusive-rejected',
                  message: outcome.decision.reason,
                  verdict: pending.verdict ?? null,
                  violations: pending.snapshot?.violations ?? [],
                },
              }
            : {
                ...node,
                status: 'done',
                endedAt: decidedAt,
                output: { accepted: true, violations: pending.snapshot?.violations ?? [], judged: true, arbitrated: true },
                ...(artifact === null ? {} : { artifactId: artifact.artifactId }),
              }
        }
      } else {
        current.nodes[pending.nodeId] = {
          ...node,
          status: rejected ? 'failed' : 'done',
          output: {
            decision: outcome.decision.decision,
            reason: outcome.decision.reason,
            decidedAt: outcome.decision.decidedAt,
            ...(outcome.decision.artifact === undefined ? {} : { artifact: outcome.decision.artifact }),
          },
          endedAt: decidedAt,
          ...(rejected ? { diagnostic: { code: 'gate-rejected', message: outcome.decision.reason } } : {}),
        }
        if (outcome.decision.artifact !== undefined) {
          // "Modified approval" is a new artifact revision, not a rewritten
          // upstream artifact: history stays append-only and downstream nodes
          // read the gate's output.
          current.artifactRevisions = Array.isArray(current.artifactRevisions) ? current.artifactRevisions : []
          current.artifactRevisions.push({
            revision: current.artifactRevisions.length + 1,
            gateId: pending.id,
            nodeId: pending.nodeId,
            value: outcome.decision.artifact,
            at: decidedAt,
            decidedBy: 'owner',
          })
        }
      }
      current.audit = Array.isArray(current.audit) ? current.audit : []
      current.audit.push(audit)
      if (rejected) activateFallbacks(flow, current, pending.nodeId, { code: 'gate-rejected', message: outcome.decision.reason })
      current.status = 'running'
      await store.putRun(current)
      return current
    })
    const settled = enqueue(input.runId, () => step(input.runId))
    return { runId: record.runId, status: 'running', settled }
  }

  /**
   * Submit a human deliverable.
   * @param {{runId: string, requestId: string, payload: unknown, revision?: number}} input - delivery.
   * @returns {Promise<{runId: string, status: string, settled: Promise<Record<string, any> | null>}>} result.
   */
  async function deliver(input) {
    const record = await enqueue(input.runId, async () => {
      const current = await requireRun(input.runId)
      const pending = current.pending.find((entry) => entry.id === input.requestId)
      if (pending === undefined || pending.kind !== 'request') throw new HnflowError('request-missing', `no request ${input.requestId} in run ${input.runId}`)
      const outcome = checkDelivery(pending, input.payload, { now: now(), revision: pending.revision })
      if (!outcome.ok) throw new HnflowError(outcome.code, outcome.message, { violations: outcome.violations })
      // A delivery is data, not authority: its paths must stay inside the
      // workspace before any downstream node can act on them.
      const pathCheck = await checkDeliverablePaths(input.payload, { cwd: current.workspace, fs: hosts.fs() })
      if (!pathCheck.ok) {
        throw new HnflowError('path-outside-workspace', `the delivery has ${pathCheck.violations.length} unsafe path(s)`, {
          violations: pathCheck.violations,
        })
      }
      const flow = await flowOf(current)
      const nodeDef = findNode(flow, pending.nodeId)
      const deliveryId = `del-${randomUUID().replace(/-/gu, '').slice(0, 12)}`
      pending.delivery = {
        ...outcome.delivery,
        deliveryId,
        decidedBy: 'owner',
        paths: pathCheck.warnings,
      }
      pending.deliveryId = deliveryId
      pending.decidedBy = 'owner'
      pending.decidedAt = outcome.delivery.submittedAt
      pending.decision = { decision: 'approved', reason: '', decidedAt: outcome.delivery.submittedAt }
      const node = nodeState(current, pending.nodeId)
      if (pending.gap !== null && pending.gap !== undefined) {
        // A child asked for something only a human can provide: continue the
        // same agent node with the delivery attached, rather than completing it.
        current.nodes[pending.nodeId] = { ...node, status: 'pending', humanDelivery: outcome.delivery.payload }
      } else {
        const artifact = registerArtifact(current, nodeDef, { accepted: true, source: 'human' })
        current.nodes[pending.nodeId] = {
          ...node,
          status: 'done',
          output: outcome.delivery.payload,
          endedAt: now().toISOString(),
          ...(artifact === null ? {} : { artifactId: artifact.artifactId }),
        }
      }
      current.audit = Array.isArray(current.audit) ? current.audit : []
      current.audit.push({
        at: now().toISOString(),
        kind: 'delivery',
        pendingId: pending.id,
        nodeId: pending.nodeId,
        flowRevision: pending.flowRevision ?? null,
        contentHash: pending.contentHash ?? null,
        upstreamHash: pending.upstreamHash ?? null,
        askedVia: pending.askedVia ?? 'inbox',
        consumerNodeIds: pending.consumerNodeIds ?? [],
        deliveryId,
        delivery: outcome.delivery,
        decidedBy: 'owner',
      })
      current.status = 'running'
      await store.putRun(current)
      return current
    })
    const settled = enqueue(input.runId, () => step(input.runId))
    return { runId: record.runId, status: 'running', settled }
  }

  /**
   * Write a workspace override (an agent draft; never a revision).
   * @param {{cwd: string, key: string, definition: Record<string, any>, note?: string, origin?: 'agent'|'user'}} input - draft input.
   * @returns {Promise<Record<string, any>>} draft metadata and validation.
   */
  async function draft(input) {
    const resolved = await resolveGroupFlow(input.cwd, input.key)
    requireProjectFlow(input.cwd, resolved)
    const definition = {
      ...input.definition,
      flow: {
        ...(input.definition.flow ?? {}),
        id: resolved.flowId,
        name: resolved.flowName,
      },
    }
    const validation = await validate(definition)
    if (!validation.ok) {
      throw new HnflowError('flow-invalid', `the flow does not pass validation: ${validation.errors[0].message}`, { errors: validation.errors })
    }
    await writeJson(resolved.path, definition)
    invalidateViews(input.cwd)
    return {
      draft: true,
      local: true,
      key: resolved.key,
      flowId: resolved.flowId,
      group: resolved.group,
      path: resolved.path,
      validation,
      next: 'the project-local flow file was updated; run it with hnflow run, or edit it again',
    }
  }

  /**
   * Create a flow in a project-local capability group.
   *
   * This is the only creation path: a flow is capability content, so it lives
   * under `.hnflow/groups/<group>/flows/` and the group is activated in the
   * project stack. The agent never writes a global library.
   * @param {{cwd: string, definition: Record<string, any>, name?: string, folder?: string, note?: string}} input - creation input.
   * @returns {Promise<Record<string, any>>} created flow facts.
   */
  async function createFlow(input) {
    const cwd = String(input.cwd ?? '')
    const definition = input.definition
    const flow = definition !== null && typeof definition === 'object' && definition.flow !== null && typeof definition.flow === 'object' && !Array.isArray(definition.flow) ? definition.flow : {}
    const inputName = String(input.name ?? '').trim()
    const name = String(inputName || flow.name || '').trim()
    if (name.length === 0) throw new HnflowError('name-required', 'a new flow needs a name (or definition.flow.name)')
    const group = normalizeFolder(input.folder) || 'local'
    if (group.includes('/')) throw new HnflowError('group-invalid', 'a project-local flow group is a single path segment')
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '') || 'flow'
    const flowId = typeof flow.id === 'string' && flow.id.trim().length > 0 ? flow.id.trim() : `fl-${slug}`
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(flowId)) throw new HnflowError('flow-id-invalid', `flow id must be a lowercase slug, got ${flowId}`)
    const candidate = withFlowIdentity({ ...definition, flow: { ...flow } }, flowId, name)
    const problems = definitionProblems(candidate)
    if (problems.length > 0) throw new HnflowError('definition-invalid', problems.join('; '), { problems })
    const validation = await validate(candidate)
    if (!validation.ok) {
      throw new HnflowError('flow-invalid', `the flow does not pass validation: ${validation.errors[0].message}`, { errors: validation.errors })
    }
    const directory = await ensureProjectGroup(cwd, group)
    const file = path.join(directory, 'flows', `${flowId}.flow.json`)
    if (await readJsonOrNull(file) !== null) throw new HnflowError('flow-duplicate', `group ${group} already has a flow ${flowId}`)
    await mkdir(path.dirname(file), { recursive: true })
    await writeJson(file, candidate)
    invalidateViews(cwd)
    return {
      scope: 'project',
      key: `${group}/${flowId}`,
      flowId,
      name,
      group,
      path: file,
      validation,
    }
  }

  /**
   * Promote a project-local draft into a library asset (revision 1) and
   * reference it from the same workspace.
   * @param {{cwd: string, key: string, name?: string, folder?: string, alias?: string}} input - promotion input.
   * @returns {Promise<Record<string, any>>} promoted asset facts.
   */
  async function promote(input) {
    const resolved = await resolveKey(input.cwd, input.key)
    if (resolved.local !== true) throw new HnflowError('not-local', `${input.key} is already a library flow`)
    const name = String(input.name ?? resolved.flowName).trim()
    if (name.length === 0) throw new HnflowError('name-required', 'the promoted flow needs a name')
    const folder = normalizeFolder(input.folder !== undefined ? input.folder : resolved.folder)
    const validation = await validate(resolved.definition)
    if (!validation.ok) {
      throw new HnflowError('flow-invalid', `the flow does not pass validation: ${validation.errors[0].message}`, { errors: validation.errors })
    }
    const assets = new AssetStore(libraryRoot(config), { logger })
    const created = await assets.create({
      name,
      definition: resolved.definition,
      folder,
      description: typeof resolved.definition.flow?.description === 'string' ? resolved.definition.flow.description : '',
    })
    const { workspace } = storesFor(input.cwd)
    await workspace.addRef({ flowId: String(created.asset.id), alias: input.alias ?? '', revision: null })
    await workspace.removeOverride(resolved.flowId)
    indexCache.delete(String(input.cwd))
    return {
      scope: 'library',
      flowId: String(created.asset.id),
      previousFlowId: resolved.flowId,
      name,
      folder,
      revision: 1,
      validation,
    }
  }

  /**
   * Delete a project-local draft. Library assets and references are not removed.
   * @param {{cwd: string, key: string}} input - deletion input.
   * @returns {Promise<{flowId: string, name: string, local: true}>} removed facts.
   */
  async function deleteLocal(input) {
    const resolved = await resolveGroupFlow(input.cwd, input.key)
    requireProjectFlow(input.cwd, resolved)
    await rm(resolved.path, { force: true })
    invalidateViews(input.cwd)
    return { key: resolved.key, flowId: resolved.flowId, name: resolved.flowName, group: resolved.group, local: true }
  }

  /**
   * Rename a project-local draft.
   * @param {{cwd: string, key: string, name: string}} input - rename input.
   * @returns {Promise<Record<string, any>>} renamed facts.
   */
  async function renameLocal(input) {
    const name = String(input.name ?? '').trim()
    if (name.length === 0) throw new HnflowError('name-required', 'a local flow needs a non-empty name')
    const resolved = await resolveGroupFlow(input.cwd, input.key)
    requireProjectFlow(input.cwd, resolved)
    const definition = {
      ...resolved.definition,
      flow: { ...(resolved.definition.flow ?? {}), id: resolved.flowId, name },
    }
    await writeJson(resolved.path, definition)
    invalidateViews(input.cwd)
    return { key: resolved.key, flowId: resolved.flowId, name, group: resolved.group, local: true }
  }

  /**
   * Remove a workspace reference without touching the library asset.
   * @param {{cwd: string, key: string}} input - reference removal input.
   * @returns {Promise<Record<string, any>>} removed reference facts.
   */
  async function removeRef(input) {
    const { workspace } = storesFor(input.cwd)
    const ref = await refForKey(input.cwd, input.key)
    if (ref === null) throw new HnflowError('ref-missing', `no flow named ${input.key} in this workspace`)
    const override = await workspace.readOverride(ref.flowId)
    await workspace.removeRef(ref.flowId)
    indexCache.delete(String(input.cwd))
    return { flowId: ref.flowId, alias: ref.alias ?? '', hadOverride: override !== null }
  }

  /**
   * Change a reference's alias.
   * @param {{cwd: string, key: string, alias: string}} input - rename input.
   * @returns {Promise<Record<string, any>>} updated reference facts.
   */
  async function renameRef(input) {
    const alias = String(input.alias ?? '').trim()
    if (alias.length === 0) throw new HnflowError('alias-required', 'an alias must not be empty')
    const { workspace } = storesFor(input.cwd)
    const ref = await refForKey(input.cwd, input.key)
    if (ref === null) throw new HnflowError('ref-missing', `no flow named ${input.key} in this workspace`)
    const document = await workspace.readRefs()
    const clash = document.refs.find((entry) => entry.alias === alias && entry.flowId !== ref.flowId)
    if (clash !== undefined) throw new HnflowError('ref-duplicate', `another reference already uses the alias ${alias}`)
    const updated = await workspace.updateRef(ref.flowId, { revision: ref.revision ?? null, alias })
    indexCache.delete(String(input.cwd))
    return { flowId: updated.flowId, alias: updated.alias ?? '', revision: updated.revision ?? null }
  }

  /**
   * Every reusable library asset.
   * @returns {Promise<Record<string, any>[]>} assets.
   */
  async function listLibrary() {
    return new AssetStore(libraryRoot(config), { logger }).list()
  }

  /**
   * Publish a workspace flow as a new revision.
   * @param {{cwd: string, key: string, note?: string}} input - publish input.
   * @returns {Promise<Record<string, any>>} publish result.
   */
  async function publish(input) {
    requireCapability()
    const resolved = await resolveKey(input.cwd, input.key)
    rejectLocal(resolved, 'publish')
    const validation = await validate(resolved.definition)
    if (!validation.ok) throw new HnflowError('flow-invalid', `the flow does not pass validation: ${validation.errors[0].message}`, { errors: validation.errors })
    const { assets } = storesFor(input.cwd)
    const nextRevision = Number(resolved.currentRevision ?? 1) + 1
    const lockfile = await lockfileFor({ ...resolved, revision: nextRevision, lockfile: null })
    const published = await publishFlow({ assets, definition: resolved.definition, note: input.note ?? '', lockfile })
    indexCache.delete(String(input.cwd))
    return published
  }

  /**
   * List a flow's immutable revision history.
   * @param {string} cwd - workspace root.
   * @param {string} key - alias or flow id.
   * @returns {Promise<Record<string, any>>} history.
   */
  async function history(cwd, key) {
    const resolved = await resolveKey(cwd, key)
    rejectLocal(resolved, 'show revision history for')
    const { assets } = storesFor(cwd)
    const ref = await refForKey(cwd, key)
    const revisions = await assets.listRevisions(resolved.flowId)
    return {
      flowId: resolved.flowId,
      flowName: resolved.flowName,
      alias: resolved.alias,
      source: resolved.source,
      currentRevision: resolved.currentRevision,
      // A reference that follows latest still resolves to a number; the
      // history must say "follows latest", so read the pin, not the resolution.
      pinnedRevision: ref === null ? null : ref.revision ?? null,
      revisions,
    }
  }

  /**
   * Prepare a publish: validate the candidate and diff it against the published
   * asset. No revision is created here — a human still has to confirm.
   * @param {string} cwd - workspace root.
   * @param {string} key - alias or flow id.
   * @returns {Promise<Record<string, any>>} preview.
   */
  async function previewPublish(cwd, key) {
    requireCapability()
    const resolved = await resolveKey(cwd, key)
    rejectLocal(resolved, 'publish')
    const validation = await validate(resolved.definition)
    const { assets } = storesFor(cwd)
    const current = await assets.read(resolved.flowId)
    return {
      flowId: resolved.flowId,
      flowName: resolved.flowName,
      alias: resolved.alias,
      source: resolved.source,
      currentRevision: resolved.currentRevision,
      pinnedRevision: resolved.revision,
      nextRevision: Number(resolved.currentRevision ?? 1) + 1,
      validation,
      diff: diffDefinitions(current.definition, resolved.definition),
      contentHash: contentHash(resolved.definition),
    }
  }

  /**
   * Re-pin a workspace reference.
   * @param {string} cwd - workspace root.
   * @param {string} key - alias or flow id.
   * @param {number | 'latest' | null} target - revision, latest, or null.
   * @returns {Promise<Record<string, any>>} updated ref.
   */
  async function pinRef(cwd, key, target) {
    const resolved = await resolveKey(cwd, key)
    rejectLocal(resolved, 'pin')
    const { workspace, assets } = storesFor(cwd)
    const ref = await refForKey(cwd, key)
    if (ref === null) throw new HnflowError('ref-missing', `no flow named ${key} in this workspace`)
    const revision = target === 'latest' || target === null || target === undefined ? null : Number(target)
    if (revision !== null) {
      if (!Number.isInteger(revision) || revision < 1) throw new HnflowError('revision-invalid', `revision must be a positive integer or "latest"`)
      const exists = await assets.readRevisionRecord(resolved.flowId, revision)
      if (exists === null) throw new HnflowError('revision-missing', `revision ${revision} of ${resolved.flowId} has no snapshot`)
    }
    const updated = await workspace.updateRef(ref.flowId, { revision })
    indexCache.delete(String(cwd))
    return { flowId: resolved.flowId, alias: resolved.alias, revision: updated.revision ?? null }
  }

  /**
   * Restore an old revision as a new revision (never rewrites history).
   * @param {{cwd: string, key: string, revision: number, note?: string}} input - rollback input.
   * @returns {Promise<Record<string, any>>} publish result plus `restoredFrom`.
   */
  async function rollback(input) {
    requireCapability()
    const resolved = await resolveKey(input.cwd, input.key)
    rejectLocal(resolved, 'roll back')
    const { assets } = storesFor(input.cwd)
    const record = await assets.readRevisionRecord(resolved.flowId, Number(input.revision))
    if (record === null) throw new HnflowError('revision-missing', `revision ${input.revision} of ${resolved.flowId} has no snapshot`)
    const validation = await validate(record.definition)
    if (!validation.ok) throw new HnflowError('flow-invalid', `revision ${input.revision} does not pass validation: ${validation.errors[0].message}`, { errors: validation.errors })
    const nextRevision = Number(resolved.currentRevision ?? 1) + 1
    const lockfile = await lockfileFor({ ...resolved, definition: record.definition, revision: nextRevision, lockfile: null })
    const published = await publishFlow({
      assets,
      definition: record.definition,
      note: input.note ?? `rollback to r${input.revision}`,
      lockfile,
    })
    indexCache.delete(String(input.cwd))
    return { ...published, restoredFrom: Number(input.revision) }
  }

  /**
   * List the flows of the workspace's active capability groups.
   * @param {string} cwd - workspace root.
   * @returns {Promise<Record<string, any>[]>} catalogue entries.
   */
  async function listFlows(cwd) {
    const flows = await capabilityFlows(cwd)
    return flows.map(catalogueEntry)
  }

  /**
   * Describe one capability-group flow.
   * @param {string} cwd - workspace root.
   * @param {string} key - alias or flow id.
   * @returns {Promise<Record<string, any>>} resolution.
   */
  async function describeFlow(cwd, key) {
    return resolveGroupFlow(cwd, key)
  }

  /**
   * Read one run.
   * @param {string} runId - run identity.
   * @returns {Promise<Record<string, any>>} run record.
   */
  async function getRun(runId) {
    return requireRun(runId)
  }

  /**
   * Every run, newest first.
   * @returns {Promise<Record<string, any>[]>} runs.
   */
  async function listRuns() {
    await ready()
    const runs = await store.listRuns()
    return runs.sort((left, right) => String(right.startedAt ?? '').localeCompare(String(left.startedAt ?? '')))
  }

  /**
   * Pending human work across runs.
   * @returns {Promise<Record<string, any>[]>} inbox items.
   */
  async function inbox() {
    const runs = await listRuns()
    /** @type {Record<string, any>[]} */
    const items = []
    for (const run of runs) {
      for (const pending of Array.isArray(run.pending) ? run.pending : []) {
        if (pending.decision !== undefined || pending.delivery !== undefined) continue
        const stage = stageOf(pending)
        items.push({
          id: pending.id,
          kind: pending.kind,
          runId: run.runId,
          flowName: run.flowName,
          nodeId: pending.nodeId,
          nodeTitle: pending.nodeTitle ?? pending.nodeId,
          // Derived, not stored: the page shows one sentence and one stage so a
          // flat list of ten pending items never looks like ten equal chores.
          stage: stage.stage,
          stageLabel: stage.label,
          priority: stage.priority,
          summary: pendingSummary(pending, { run }),
          createdAt: pending.createdAt,
          askedAt: pending.askedAt ?? pending.createdAt,
          askedVia: pending.askedVia ?? 'inbox',
          expiresAt: pending.expiresAt,
          expired: pending.expired === true,
          revision: pending.revision,
          attempts: pending.attempts ?? 0,
          whyHuman: pending.whyHuman,
          deliverable: pending.deliverable,
          snapshot: pending.snapshot,
          gap: pending.gap,
          // Audit facts §6.5: which revision was the human looking at, and which
          // nodes will consume the answer.
          flowRevision: pending.flowRevision ?? null,
          flowSource: pending.flowSource ?? run.source ?? 'latest',
          contentHash: pending.contentHash ?? null,
          upstreamHash: pending.upstreamHash ?? null,
          consumerNodeIds: pending.consumerNodeIds ?? [],
          origin: pending.origin ?? (pending.kind === 'gate' ? 'gate' : 'request'),
          lastViolations: pending.lastViolations ?? [],
          lastDiagnostic: pending.lastDiagnostic ?? null,
        })
      }
    }
    return sortPending(items)
  }

  /**
   * The reusable library assets, regardless of workspace refs.
   * @returns {Promise<Record<string, any>[]>} assets.
   */
  async function libraryAssets() {
    return listLibrary()
  }

  /**
   * Reference one library asset from a workspace.
   * @param {string} cwd - workspace root.
   * @param {string} flowId - library asset id or name.
   * @param {string} [alias] - preferred alias.
   * @returns {Promise<Record<string, any>>} the created ref.
   */
  async function addRef(cwd, flowId, alias) {
    const assets = new AssetStore(libraryRoot(config), { logger })
    const wanted = String(flowId ?? '').trim()
    if (wanted.length === 0) throw new HnflowError('flow-required', 'flowId is required')
    const entries = await assets.list()
    const match = entries.find((entry) => entry.id === wanted || entry.name === wanted)
    if (match === undefined) throw new HnflowError('asset-missing', `no library asset named ${wanted}`)
    const asset = await assets.read(match.id)
    const { workspace } = storesFor(cwd)
    const ref = await workspace.addRef({ flowId: String(asset.asset.id), alias: alias ?? '', revision: null })
    indexCache.delete(String(cwd))
    return { flowId: String(asset.asset.id), name: String(asset.asset.name ?? ''), alias: ref.alias ?? '', revision: ref.revision ?? null }
  }

  /**
   * The page snapshot for a set of workspaces.
   * @param {{id?: string, name?: string, path: string}[]} workspaces - workspaces to include.
   * @returns {Promise<Record<string, any>>} snapshot.
   */
  async function snapshot(workspaces) {
    const groups = []
    for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
      try {
        groups.push({ ...workspace, flows: await listFlows(workspace.path) })
      } catch (error) {
        groups.push({ ...workspace, flows: [], error: String(error?.message ?? error) })
      }
    }
    /** @type {Record<string, any>[]} */
    const triggers = []
    /** @type {{workspace: string, id: string, error: string}[]} */
    const triggerErrors = []
    for (const group of groups) {
      const root = String(group.path ?? '')
      if (root.length === 0 || config.triggersEnabled === false) continue
      knownWorkspaces.add(root)
      try {
        const file = await readTriggers(root, config)
        for (const entry of file.errors) triggerErrors.push({ workspace: root, id: entry.id, error: entry.error })
        for (const trigger of file.triggers) {
          const state = triggerState[`${root}#${trigger.id}`] ?? {}
          triggers.push({
            id: trigger.id,
            source: trigger.source,
            flow: trigger.flow,
            enabled: trigger.enabled,
            workspace: root,
            cron: trigger.cron ?? null,
            watch: trigger.watch ?? null,
            after: trigger.after ?? null,
            lastFiredAt: state.lastFiredAt ?? null,
          })
        }
      } catch (error) {
        triggerErrors.push({ workspace: root, id: '*', error: String(error?.message ?? error) })
      }
    }
    const degraded = !capabilityAvailable(hosts.capability())
    return {
      ok: true,
      degraded,
      capability: capabilityFacts(),
      storage: store.mode(),
      warnings: store.warnings(),
      workspaces: groups,
      runs: (await listRuns()).map((run) => summariseRun(run)),
      inbox: await inbox(),
      // Declarative facts: the page renders these instead of hard-coding where
      // to look for automation state.
      triggers,
      automation: { errors: triggerErrors, effects: outbox.summary(), pass: lastPass },
      facts: {
        degraded,
        storage: store.mode(),
        capability: capabilityFacts(),
        triggersEnabled: config.triggersEnabled !== false,
        passIntervalMs: config.passIntervalMs,
        runBudgetMs: config.runBudgetMs,
        channels: channels.list(),
        nodeKinds: kinds.list().map((kind) => ({ id: kind.id, title: kind.title, description: kind.description })),
      },
    }
  }

  /**
   * The flow index injected into the system prompt.
   * @param {string} cwd - workspace root.
   * @returns {Promise<string>} prompt section text.
   */
  async function indexSection(cwd) {
    const rows = await listFlows(cwd)
    if (rows.length === 0) return ''
    const lines = rows.slice(0, config.maxIndexEntries).map((row) => {
      const name = row.name || row.flowId
      const owner = row.group
      return `- ${name}（${row.flowId}，能力组 ${owner}）：${row.description?.length > 0 ? row.description : '（未写说明）'}`
    })
    const section = [
      '## 本工作区的 HNFlow 流程',
      '',
      ...lines,
      '',
      '用 `hnflow` 工具（list_flows / describe_flow / run / status / inbox / cancel / resume / artifact / triggers）运行；用 `hnflow_author`（schema / validate / create / draft / delete / rename）创建和管理。流程属于能力组：项目草稿写 `.hnflow/groups/<group>/flows/`，共享流程写能力组目录；没有发布、版本或资产库动作。',
    ].join('\n')
    indexCache.set(cwd, section)
    return section
  }

  /**
   * The cached index for a workspace.
   * @param {string} cwd - workspace root.
   * @returns {string} section text (empty before the first refresh).
   */
  function cachedIndex(cwd) {
    return indexCache.get(cwd) ?? ''
  }

  /**
   * Path of the trigger bookkeeping file.
   * @returns {string} absolute path.
   */
  function triggerStatePath() {
    return path.join(stateDirectory(config), 'triggers-state.json')
  }

  /**
   * Read the trigger bookkeeping file.
   * @returns {Promise<Record<string, any>>} state (empty when unreadable).
   */
  async function loadTriggerState() {
    try {
      const parsed = await readJsonOrNull(triggerStatePath())
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch (error) {
      logger.warn?.('hnflow: cannot read the trigger state: %o', error)
      return {}
    }
  }

  /**
   * Persist the trigger bookkeeping file.
   * @returns {Promise<void>} resolves once durable.
   */
  async function saveTriggerState() {
    try {
      await writeJson(triggerStatePath(), triggerState)
    } catch (error) {
      logger.warn?.('hnflow: cannot write the trigger state: %o', error)
    }
  }

  /**
   * Start a run on behalf of a trigger.
   *
   * The run is started through the same `run()` path as a person's request, so
   * validation, lockfile pinning and workspace resolution are identical. The
   * trigger only decides *when*; it never bypasses a gate.
   * @param {{workspace: string, trigger: Record<string, any>, key: string, chain?: string[]}} input - firing.
   * @returns {Promise<void>} resolves once started.
   */
  async function startTriggeredRun(input) {
    const started = await run({
      cwd: input.workspace,
      key: input.trigger.flow,
      input: input.trigger.input ?? {},
      trigger: { source: input.trigger.source, triggerId: input.trigger.id, key: input.key, chain: input.chain ?? [] },
    })
    void started.settled.catch((error) => logger.warn?.('hnflow: a triggered run failed: %o', error))
  }

  /**
   * Turn a `run-completed` effect into runs.
   * @param {Record<string, any>} effect - outbox effect.
   * @param {Record<string, any>} report - pass report.
   * @returns {Promise<void>} resolves once handled.
   */
  async function deliverTriggerEffect(effect, report) {
    const payload = effect.payload ?? {}
    const runId = String(payload.runId ?? '')
    const source = runId.length > 0 ? await store.getRun(runId) : null
    if (source === null) {
      await outbox.markDone(effect.id, 'source run missing')
      return
    }
    const workspace = String(source.workspace ?? '')
    const chain = Array.isArray(payload.chain) ? [...payload.chain, runId] : [runId]
    if (workspace.length === 0 || chain.length > 5) {
      await outbox.markDone(effect.id, 'chain too deep')
      return
    }
    const file = await readTriggers(workspace, config)
    const matching = runCompletedTriggers(file.triggers, String(payload.flowId ?? ''))
    for (const trigger of matching) {
      const stateKey = `${workspace}#${trigger.id}`
      const dedupe = `${trigger.id}:${runId}`
      if (triggerState[stateKey]?.lastKey === dedupe) continue
      await startTriggeredRun({ workspace, trigger, key: dedupe, chain })
      triggerState[stateKey] = { lastKey: dedupe, lastFiredAt: now().toISOString() }
      report.triggers += 1
    }
    await saveTriggerState()
    await outbox.markDone(effect.id, `${matching.length} trigger(s)`)
  }

  /**
   * Evaluate the polling trigger sources for every known workspace.
   * @param {Record<string, any>} report - pass report.
   * @returns {Promise<void>} resolves once evaluated.
   */
  async function evaluateWorkspaceTriggers(report) {
    if (config.triggersEnabled === false) return
    for (const workspace of [...knownWorkspaces]) {
      const file = await readTriggers(workspace, config)
      if (file.missing) continue
      const evaluated = await evaluateTriggers({ workspace, triggers: file.triggers, state: triggerState, now: now() })
      triggerState = evaluated.state
      for (const error of evaluated.errors) report.errors.push(`trigger ${error.id}: ${error.error}`)
      for (const firing of evaluated.fired) {
        try {
          await startTriggeredRun({ workspace, trigger: firing.trigger, key: firing.key, chain: [] })
          report.triggers += 1
        } catch (error) {
          report.errors.push(`trigger ${firing.trigger.id}: ${String(error?.message ?? error)}`)
          logger.warn?.('hnflow: trigger %s could not start %s: %o', firing.trigger.id, firing.trigger.flow, error)
        }
      }
      await saveTriggerState()
    }
  }

  /**
   * Advance runs that are marked running but have no live chain.
   * @param {Record<string, any>} report - pass report.
   * @returns {Promise<void>} resolves once advanced.
   */
  async function advanceStalledRuns(report) {
    const runs = await store.listRuns()
    const stamp = now().getTime()
    for (const run of runs) {
      if (run.status !== 'running' || chains.has(run.runId)) continue
      const live = active.get(run.runId)
      if (live !== undefined && live.size > 0) continue
      const last = Date.parse(String(run.updatedAt ?? run.startedAt ?? ''))
      if (!Number.isFinite(last) || stamp - last < 60_000) continue
      report.advanced += 1
      void enqueue(run.runId, () => step(run.runId)).catch((error) => logger.warn?.('hnflow: advancing a stalled run failed: %o', error))
    }
  }

  /**
   * One pass: expiry, durable effects, triggers, stalled runs.
   *
   * Called by the `hnflow-pass` row every `passIntervalMs`. Re-entrant calls are
   * skipped, so a slow pass delays the next tick instead of stacking.
   * @returns {Promise<Record<string, any>>} pass report.
   */
  async function pass() {
    if (disposed || passRunning) return lastPass
    passRunning = true
    /** @type {Record<string, any>} */
    const report = { at: now().toISOString(), error: null, expired: 0, effects: 0, triggers: 0, advanced: 0, errors: [] }
    try {
      await ready()
      await sweepExpired()
      for (const effect of outbox.due(now())) {
        try {
          if (effect.kind === 'notice') {
            await outbox.markDone(effect.id, 'noticed')
            report.effects += 1
          } else if (effect.kind === 'trigger') {
            await deliverTriggerEffect(effect, report)
            report.effects += 1
          } else {
            await outbox.markDone(effect.id, 'ignored')
          }
        } catch (error) {
          await outbox.markFailed(effect.id, String(error?.message ?? error))
          report.errors.push(`effect ${effect.kind}: ${String(error?.message ?? error)}`)
        }
      }
      await evaluateWorkspaceTriggers(report)
      await advanceStalledRuns(report)
    } catch (error) {
      report.error = String(error?.message ?? error)
      report.errors.push(report.error)
      logger.warn?.('hnflow: the pass failed: %o', error)
    } finally {
      passRunning = false
      lastPass = report
    }
    return report
  }

  /**
   * Mark expired pending human work (no automatic decision is taken).
   * @returns {Promise<void>} resolves after the scan.
   */
  async function sweepExpired() {
    if (disposed) return
    /** @type {string[]} */
    const touched = []
    try {
      const runs = await store.listRuns()
      for (const run of runs) {
        if (TERMINAL_RUN.has(run.status)) continue
        let changed = false
        for (const pending of Array.isArray(run.pending) ? run.pending : []) {
          if (pending.decision !== undefined || pending.delivery !== undefined) continue
          if (typeof pending.expiresAt !== 'string' || pending.expired === true) continue
          if (Date.parse(pending.expiresAt) > now().getTime()) continue
          pending.expired = true
          pending.expiredAt = now().toISOString()
          changed = true
          run.audit = Array.isArray(run.audit) ? run.audit : []
          run.audit.push({
            at: now().toISOString(),
            kind: 'expired',
            pendingId: pending.id,
            nodeId: pending.nodeId,
            flowRevision: pending.flowRevision ?? null,
            contentHash: pending.contentHash ?? null,
            decision: null,
            onExpire: pending.onExpire ?? 'remind',
          })
          if (pending.onExpire !== 'fail') continue
          // `fail` is a real state transition, not a badge: the node fails, its
          // fallback activates, and the run continues to a verdict.
          run.nodes[pending.nodeId] = {
            ...nodeState(run, pending.nodeId),
            status: 'failed',
            diagnostic: {
              code: pending.kind === 'request' ? 'request-expired' : 'gate-expired',
              message: pending.kind === 'request' ? 'the deliverable was not provided before its deadline' : 'the gate was not decided before its deadline',
            },
          }
          const flow = await flowOf(run)
          // Closing the pending record is what lets the run advance: without a
          // decision marker, `step` would park on it again as waiting_human.
          pending.decision = { decision: 'expired', reason: 'the deadline passed', decidedAt: now().toISOString() }
          pending.closedBy = 'expiry'
          activateFallbacks(flow, run, pending.nodeId, { code: 'expired', message: pending.onExpire })
          run.status = 'running'
        }
        if (changed) {
          await store.putRun(run)
          touched.push(run.runId)
        }
      }
    } catch (error) {
      logger.warn?.('hnflow: the expiry sweep failed: %o', error)
    }
    for (const runId of touched) {
      if (disposed) return
      void enqueue(runId, () => step(runId)).catch((error) => logger.warn?.('hnflow: advancing an expired run failed: %o', error))
    }
  }

  /**
   * Read one artifact plus its current value.
   * @param {string} artifactId - artifact id.
   * @returns {Promise<Record<string, any>>} artifact view.
   * @throws {HnflowError} `artifact-missing`.
   */
  async function getArtifact(artifactId) {
    await ready()
    const runs = await store.listRuns()
    for (const run of runs) {
      const view = artifactView(run, artifactId)
      if (view !== null) return view
    }
    throw new HnflowError('artifact-missing', `no artifact named ${artifactId}`)
  }

  /**
   * Open the store and reconcile runs left behind by a previous process.
   * @returns {Promise<void>} resolves once open.
   */
  async function open() {
    opened = (async () => {
      await store.open()
      try {
        await outbox.open()
      } catch (error) {
        logger.warn?.('hnflow: cannot open the effect queue: %o', error)
      }
      triggerState = await loadTriggerState()
      const runs = await store.listRuns()
      const interrupted = []
      for (const run of runs) {
        if (String(run.workspace ?? '').length > 0) knownWorkspaces.add(String(run.workspace))
        if (run.status === 'running' || run.status === 'queued' || run.status === 'interrupted') {
          for (const [id, state] of Object.entries(run.nodes)) {
            if (state.status === 'running') run.nodes[id] = { ...state, status: 'interrupted', endedAt: now().toISOString() }
          }
          run.status = 'interrupted'
          run.error = { code: 'interrupted', message: 'the host process ended while the run was working; resume explicitly' }
          run.updatedAt = now().toISOString()
          await store.putRun(run)
          interrupted.push(run)
        }
      }
      // Recovery is opt-out, not opt-in: an interrupted run is the common case
      // after an upgrade or a laptop sleep, and leaving it parked is exactly the
      // "forgot about it" failure this version exists to remove.
      if (config.resumeOnStart !== false) {
        for (const run of interrupted) {
          try {
            run.status = 'running'
            run.error = null
            run.recovery = { reason: 'host-restarted', at: now().toISOString() }
            for (const [id, state] of Object.entries(run.nodes)) {
              if (state.status === 'running' || state.status === 'interrupted') run.nodes[id] = { ...state, status: 'pending' }
            }
            run.updatedAt = now().toISOString()
            await store.putRun(run)
            active.set(run.runId, new Set())
            void enqueue(run.runId, () => step(run.runId)).catch((error) => logger.warn?.('hnflow: resuming an interrupted run failed: %o', error))
          } catch (error) {
            logger.warn?.('hnflow: cannot resume run %s: %o', run.runId, error)
          }
        }
      }
    })()
    await opened
  }

  /**
   * Register an extra deterministic node kind.
   * @param {Record<string, any>} kind - `{id, title?, description?, run}`.
   * @returns {Record<string, any>} the registered kind.
   */
  function registerNodeKind(kind) {
    const record = kinds.register(kind)
    indexCache.clear()
    return record
  }

  /**
   * Register an extra delivery channel for human work.
   * @param {Record<string, any>} channel - `{id, title, send, enabled?}`.
   * @returns {Record<string, any>} the registered channel.
   */
  function registerChannel(channel) {
    return channels.register(channel)
  }

  /**
   * Trigger rows across known workspaces (read-only).
   * @returns {Promise<{triggers: Record<string, any>[], errors: Record<string, any>[], enabled: boolean}>} triggers.
   */
  async function triggers() {
    await ready()
    /** @type {Record<string, any>[]} */
    const rows = []
    /** @type {Record<string, any>[]} */
    const errors = []
    for (const workspace of [...knownWorkspaces]) {
      const file = await readTriggers(workspace, config)
      for (const entry of file.errors) errors.push({ workspace, id: entry.id, error: entry.error })
      for (const trigger of file.triggers) {
        const state = triggerState[`${workspace}#${trigger.id}`] ?? {}
        rows.push({ ...trigger, workspace, lastFiredAt: state.lastFiredAt ?? null })
      }
    }
    return { triggers: rows, errors, enabled: config.triggersEnabled !== false }
  }

  /**
   * Stop accepting work and release the store.
   * @returns {Promise<void>} resolves once closed.
   */
  async function close() {
    disposed = true
    for (const activations of active.values()) {
      for (const activation of activations) await activation.dispose().catch(() => {})
    }
    active.clear()
    await store.close()
    if (conductorHandle !== null) {
      await conductorHandle.dispose?.().catch(() => {})
      conductorHandle = null
    }
    conductor = null
  }

  return {
    open,
    close,
    run,
    resume,
    cancel,
    decide,
    deliver,
    draft,
    createFlow,
    deleteLocal,
    renameLocal,
    listFlows,
    describeFlow,
    getRun,
    listRuns,
    inbox,
    snapshot,
    getArtifact,
    indexSection,
    cachedIndex,
    validate,
    sweepExpired,
    pass,
    triggers,
    registerNodeKind,
    registerChannel,
    nodeKinds: () => [...NODE_TYPES, ...kinds.list().map((kind) => kind.id)],
    status: () => ({ degraded: !capabilityAvailable(hosts.capability()), capability: capabilityFacts(), storage: store.mode(), warnings: store.warnings(), runner: runner.available(), pass: lastPass }),
  }
}

/**
 * A compact run summary for lists and the page.
 * @param {Record<string, any>} run - run record.
 * @returns {Record<string, any>} summary.
 */
export function summariseRun(run) {
  return {
    runId: run.runId,
    flowId: run.flowId,
    flowName: run.flowName,
    key: run.key,
    status: run.status,
    health: runHealth(run),
    workspace: run.workspace,
    hostSessionId: run.hostSessionId,
    group: run.group ?? null,
    revision: run.revision,
    source: run.source ?? 'capability',
    trigger: run.trigger ?? null,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt ?? null,
    endedAt: run.endedAt,
    error: run.error,
    nodes: Object.entries(run.nodes ?? {}).map(([id, state]) => ({
      id,
      status: state.status,
      attempts: state.attempts,
      childSessionId: state.childSessionId ?? null,
      diagnostic: state.diagnostic ?? null,
    })),
    pending: (run.pending ?? []).filter((entry) => entry.decision === undefined && entry.delivery === undefined).length,
    usage: run.usage ?? null,
    degradations: Array.isArray(run.degradations) ? run.degradations : [],
    artifactRevisions: Array.isArray(run.artifactRevisions) ? run.artifactRevisions : [],
    artifacts: artifactList(run),
  }
}
