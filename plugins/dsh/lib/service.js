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

import { createStore } from './store.js'
import { AssetStore } from './assets.js'
import { contentHash, buildLockfile, lockfileProblems, publishFlow } from './flow/publish.js'
import { nodeIndex, outgoingEdges } from './flow/definition.js'
import { envelopeSchema, judgeEnvelopeSchema, parseEnvelope, parseVerdict } from './flow/envelope.js'
import { validateValue } from './flow/schema.js'
import { validateFlow } from './flow/validate.js'
import { agentOptionsOf, layerStatus, vibestackAvailable, vibestackOf } from './layers.js'
import { buildJudgeBrief, buildNodeBrief } from './prompt.js'
import { createSubagentRunner, withTimeout } from './runner.js'
import { activateFallbacks, impliedStatus, nodeState, runnableNodes, settle, upstreamArtifacts } from './scheduler.js'
import { createGatePending, decideGate, gateQuestion } from './gates.js'
import { checkDelivery, createRequestPending, rejectionStep } from './requests.js'
import { PLUGIN_VERSION } from './config.js'
import { createStores } from './resolve.js'
import { libraryRoot } from './paths.js'
import { hashOf } from './json.js'
import { diffDefinitions } from './diff.js'
import { artifactList, artifactView, registerArtifact } from './artifacts.js'
import { checkDeliverablePaths } from './deliverable.js'
import { addUsage, usageFromSession } from './usage.js'

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
  /** Set when the service is closing. */
  let disposed = false
  /** @type {Promise<void> | null} */
  let opened = null
  /** @type {NodeJS.Timeout | null} */
  let sweep = null

  /** Host services are read lazily: rows load in order. */
  const hosts = {
    /**
     * @returns {Record<string, any> | undefined} VibeStack model-layer service.
     */
    vibestack() {
      return vibestackOf(ctx)
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
   * @returns {{allowlist: string[], vibestackAvailable: boolean, checkPreset: Function, checkLayer: Function}} facts.
   */
  function hostFacts() {
    const vibestack = hosts.vibestack()
    return {
      allowlist: config.presetAllowlist,
      vibestackAvailable: vibestackAvailable(vibestack),
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
      checkLayer: (id) => layerStatus(vibestack, id),
    }
  }

  /**
   * Refuse work while VibeStack is missing.
   * @returns {void}
   * @throws {HnflowError} `vibestack-unavailable`.
   */
  function requireVibestack() {
    if (!vibestackAvailable(hosts.vibestack())) {
      throw new HnflowError('vibestack-unavailable', 'HNFlow needs the VibeStack plugin (apiVersion >= 2) for capability groups and model layers')
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
    const vibestack = hosts.vibestack()
    const presets = hosts.presets()
    return buildLockfile({
      definition: resolved.definition,
      revision: Number.isInteger(resolved.revision) ? resolved.revision : 0,
      pluginVersion: PLUGIN_VERSION,
      vibestack,
      layerStatus: (id) => layerStatus(vibestack, id),
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
   * VibeStack default layer.
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
    const vibestack = hosts.vibestack()
    if (typeof vibestack?.defaultLayer === 'function' && typeof vibestack?.resolveLayer === 'function') {
      try {
        const layer = vibestack.resolveLayer(vibestack.defaultLayer())
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
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (run.cancelRequested === true) return { kind: 'cancelled' }
      /** @type {Record<string, any>} */
      let activation
      try {
        activation = await runner.spawn({
          parent: host,
          cwd: run.workspace,
          preset: node.preset,
          agentOptions: route,
          label: `${run.runId}/${node.id}#${attempt}`,
          prompt,
          outputSchema: schema,
        })
      } catch (error) {
        last = { code: String(error?.code ?? 'node-spawn-failed'), message: String(error?.message ?? error) }
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
        continue
      }
      last = {
        code: result?.stopReason === 'completed' ? 'node-envelope-invalid' : 'node-failed',
        message: envelope.message ?? `stopReason=${String(result?.stopReason ?? 'unknown')}`,
      }
      lastUsage = usage
    }
    return { kind: 'failed', diagnostic: last ?? { code: 'node-failed', message: `node ${node.id} failed` }, usage: lastUsage }
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
    const result = await spawnNode({ run, node, host, prompt, schema: envelopeSchema(node.output) })
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
      default:
        return { status: 'failed', diagnostic: { code: 'node-type-invalid', message: `unsupported node type ${String(node.type)}` } }
    }
  }

  /**
   * Offer a gate as a native question card, in addition to the inbox.
   *
   * The card is a convenience, never the source of truth: the pending record is
   * already durable, so a missing answerer, an unrendered card or a timeout only
   * means the decision happens on the page instead. The decision is submitted
   * after the current step settles its own chain (no re-entrant deadlock).
   * @param {Record<string, any>} run - run record.
   * @param {Record<string, any>} node - gate node.
   * @param {Record<string, any>} pending - pending record.
   * @param {Record<string, any>} host - live root agent.
   * @returns {void}
   */
  function askGate(run, node, pending, host) {
    const questions = hosts.questions()
    if (typeof questions?.ask !== 'function' || pending.asked === 'card') return
    pending.asked = 'card'
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
        run.error = { code: 'cancelled', message: 'the run was cancelled' }
        await store.putRun(run)
        return run
      }
      run.revisionCounter = Number(run.revisionCounter ?? 0) + 1
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
   * @param {{cwd: string, key: string, input?: Record<string, any>, hostSessionId?: string}} input - start input.
   * @returns {Promise<{runId: string, status: string, settled: Promise<Record<string, any> | null>}>} started run.
   */
  async function run(input) {
    await ready()
    requireVibestack()
    const resolved = await resolveKey(input.cwd, input.key)
    const validation = await validate(resolved.definition)
    if (!validation.ok) {
      throw new HnflowError('flow-invalid', `the flow does not pass validation: ${validation.errors[0].message}`, { errors: validation.errors })
    }
    const lockfile = await lockfileFor(resolved)
    const problems = lockfileProblems(resolved.lockfile, { pluginVersion: PLUGIN_VERSION, vibestack: hosts.vibestack() })
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
    /** @type {Record<string, any>} */
    const record = {
      runId,
      flowId: resolved.flowId,
      flowName: resolved.flowName || resolved.definition?.flow?.name || resolved.key,
      key: resolved.key,
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
      createdAt: now().toISOString(),
      startedAt: now().toISOString(),
      endedAt: null,
      error: null,
      nodes: Object.fromEntries([...nodeIndex(resolved.definition).keys()].map((id) => [id, { status: 'pending', attempts: 0 }])),
      pending: [],
      fallbacks: [],
      degradations: [],
      artifacts: {},
      usage: null,
      audit: [],
      warnings: problems.warnings,
      cancelRequested: false,
      revisionCounter: 0,
    }
    await store.putRun(record)
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
    const resolved = await resolveKey(input.cwd, input.key)
    const { workspace } = storesFor(input.cwd)
    const definition = {
      ...input.definition,
      flow: {
        ...(input.definition.flow ?? {}),
        id: resolved.flowId,
        name: typeof input.definition.flow?.name === 'string' && input.definition.flow.name.trim().length > 0 ? input.definition.flow.name : resolved.flowName,
      },
    }
    const document = await workspace.writeOverride({
      flowId: resolved.flowId,
      definition,
      baseRevision: resolved.currentRevision,
      note: input.note ?? '',
      origin: input.origin === 'user' ? 'user' : 'agent',
    })
    const validation = await validate(definition)
    indexCache.delete(String(input.cwd))
    return {
      draft: true,
      flowId: resolved.flowId,
      baseRevision: document.baseRevision,
      updatedAt: document.updatedAt,
      validation,
      next: 'a human must publish it (/hnflow publish <flow>) before it becomes a revision',
    }
  }

  /**
   * Publish a workspace flow as a new revision.
   * @param {{cwd: string, key: string, note?: string}} input - publish input.
   * @returns {Promise<Record<string, any>>} publish result.
   */
  async function publish(input) {
    requireVibestack()
    const resolved = await resolveKey(input.cwd, input.key)
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
    const { assets, workspace } = storesFor(cwd)
    const ref = await workspace.findRef(key)
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
    requireVibestack()
    const resolved = await resolveKey(cwd, key)
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
    const { workspace, assets } = storesFor(cwd)
    const revision = target === 'latest' || target === null || target === undefined ? null : Number(target)
    if (revision !== null) {
      if (!Number.isInteger(revision) || revision < 1) throw new HnflowError('revision-invalid', `revision must be a positive integer or "latest"`)
      const exists = await assets.readRevisionRecord(resolved.flowId, revision)
      if (exists === null) throw new HnflowError('revision-missing', `revision ${revision} of ${resolved.flowId} has no snapshot`)
    }
    const updated = await workspace.updateRef(key, { revision })
    indexCache.delete(String(cwd))
    return { flowId: resolved.flowId, alias: resolved.alias, revision: updated.revision ?? null }
  }

  /**
   * Restore an old revision as a new revision (never rewrites history).
   * @param {{cwd: string, key: string, revision: number, note?: string}} input - rollback input.
   * @returns {Promise<Record<string, any>>} publish result plus `restoredFrom`.
   */
  async function rollback(input) {
    requireVibestack()
    const resolved = await resolveKey(input.cwd, input.key)
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
   * List the workspace's referenced flows.
   * @param {string} cwd - workspace root.
   * @returns {Promise<Record<string, any>[]>} catalogue entries.
   */
  async function listFlows(cwd) {
    return storesFor(cwd).resolver.catalogue()
  }

  /**
   * Describe one referenced flow.
   * @param {string} cwd - workspace root.
   * @param {string} key - alias or flow id.
   * @returns {Promise<Record<string, any>>} resolution.
   */
  async function describeFlow(cwd, key) {
    return resolveKey(cwd, key)
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
        items.push({
          id: pending.id,
          kind: pending.kind,
          runId: run.runId,
          flowName: run.flowName,
          nodeId: pending.nodeId,
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
    return items.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
  }

  /**
   * The reusable library assets, regardless of workspace refs.
   * @returns {Promise<Record<string, any>[]>} assets.
   */
  async function libraryAssets() {
    return new AssetStore(libraryRoot(config), { logger }).list()
  }

  /**
   * Reference one library asset from a workspace (human action).
   * @param {string} cwd - workspace root.
   * @param {string} flowId - library asset id.
   * @param {string} [alias] - preferred alias.
   * @returns {Promise<Record<string, any>>} the created ref.
   */
  async function addRef(cwd, flowId, alias) {
    const assets = new AssetStore(libraryRoot(config), { logger })
    const asset = await assets.read(flowId)
    const { workspace } = storesFor(cwd)
    const ref = await workspace.addRef({ flowId: String(asset.asset.id), alias: alias ?? '', revision: null })
    indexCache.delete(String(cwd))
    return { flowId: String(asset.asset.id), alias: ref.alias ?? '', revision: ref.revision ?? null }
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
    return {
      ok: true,
      degraded: !vibestackAvailable(hosts.vibestack()),
      storage: store.mode(),
      warnings: store.warnings(),
      library: await libraryAssets(),
      workspaces: groups,
      runs: (await listRuns()).map(summariseRun),
      inbox: await inbox(),
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
      const name = row.alias.length > 0 ? row.alias : row.flowId
      return `- ${name}：${row.description?.length > 0 ? row.description : '（未写说明）'}${row.missing ? ' [资产缺失]' : ''}`
    })
    const section = ['## 本工作区的 HNFlow 流程', '', ...lines, '', '用 `hnflow` 工具（list_flows / describe_flow / run）操作；不要凭名字猜流程内容。'].join('\n')
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
      const runs = await store.listRuns()
      for (const run of runs) {
        if (run.status === 'running' || run.status === 'queued') {
          for (const [id, state] of Object.entries(run.nodes)) {
            if (state.status === 'running') run.nodes[id] = { ...state, status: 'interrupted', endedAt: now().toISOString() }
          }
          run.status = 'interrupted'
          run.error = { code: 'interrupted', message: 'the host process ended while the run was working; resume explicitly' }
          await store.putRun(run)
        }
      }
    })()
    await opened
    sweep = setInterval(() => {
      void sweepExpired()
    }, 60_000)
    if (typeof sweep.unref === 'function') sweep.unref()
  }

  /**
   * Stop accepting work and release the store.
   * @returns {Promise<void>} resolves once closed.
   */
  async function close() {
    disposed = true
    if (sweep !== null) clearInterval(sweep)
    sweep = null
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
    publish,
    previewPublish,
    history,
    rollback,
    pinRef,
    addRef,
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
    resolveKey,
    sweepExpired,
    status: () => ({ degraded: !vibestackAvailable(hosts.vibestack()), storage: store.mode(), warnings: store.warnings(), runner: runner.available() }),
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
    workspace: run.workspace,
    hostSessionId: run.hostSessionId,
    revision: run.revision,
    source: run.source ?? 'latest',
    startedAt: run.startedAt,
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
    artifacts: artifactList(run),
  }
}
