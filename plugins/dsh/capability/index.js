/**
 * HNFlow mode for DeepSeek Harness.
 *
 * The plugin is mounted as a child row of the `capability` agent preset, so every
 * registration it makes — instruction messages, skills, commands, MCP servers,
 * the persona section — lands in that agent's scope. No other working mode is
 * touched.
 *
 * The roster is written only from `agent/pre-step`, i.e. after the harness has
 * appended its first `system/message`. `system/message` must be the first
 * surface event of a stored session, so appending a `user/message` on preset
 * selection would make the log unreadable after a restart. Binding the preset
 * still resolves the plan and registers commands; the composer reads the
 * roster before the first turn through the read-only `/api/capability/roster`
 * route served by the core row, so the Agent menu exists without touching the
 * log.
 *
 * Everything here is failure-open: a missing CLI, a broken stack, an
 * unexpected payload, or an unavailable optional service degrades to a log line.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PROJECTION_KEY,
  SELECT_COMMAND,
  agentList,
  createProjectionDefinition,
  createRoster,
  personaAgents,
  pickDefaultAgent,
} from './lib/agents.js'
import { activateAndResolve, stackPath } from './lib/activate.js'
import { commandEntries, renderTemplate } from './lib/commands.js'
import { resolveConfig } from './lib/config.js'
import { loadCatalog } from './lib/catalog.js'
import { createUserMessage as createLocalUserMessage } from './lib/messages.js'
import { normalizeMcpEntries, syncMcpServers } from './lib/mcp.js'
import { createModelsRoute } from './lib/models-route.js'
import { planUsable, unusablePlanReason } from './lib/plan.js'
import { PlanCache } from './lib/plans.js'
import { resolvePlan as resolveProjectPlan } from './lib/resolve.js'
import { createInventoryRoutes } from './lib/inventory-route.js'
import { createPrepareRoute } from './lib/prepare-route.js'
import { createRosterRoute } from './lib/roster-route.js'
import { renderRules } from './lib/rules.js'
import { CapabilityService } from './lib/service.js'
import { diagnoseSessionCwd, existingDirectory, resolveSessionCwd } from './lib/session-cwd.js'
import { createSkillProvider, readSkillFile, skillCandidates } from './lib/skills.js'

/** Plugin name shown in Loader diagnostics. */
export const name = 'capability'

/**
 * Express a working directory relative to the project root the resolver reported.
 *
 * Rule scoping uses this value, so an unknown root degrades to the directory
 * itself instead of guessing a parent.
 * @param {unknown} project - absolute project root from the plan.
 * @param {string} cwd - absolute session working directory.
 * @returns {string} posix-style relative path, or '' when they are the same.
 */
function relativeTo(project, cwd) {
  if (typeof project !== 'string' || project.length === 0) return ''
  const relative = path.relative(project, cwd)
  if (relative.length === 0 || relative.startsWith('..')) return ''
  return relative.split(path.sep).join('/')
}

/**
 * Optional Config schema.
 *
 * The schema lives in `@deepseek-ai/schemastery`, a harness-provided package.
 * The dynamic import keeps the module usable under plain Node tests, where the
 * package is absent; the Loader resolves it in a real DSH composition.
 * @type {object | undefined}
 */
let Config
try {
  const schemastery = await import('@deepseek-ai/schemastery')
  const z = schemastery.default?.z ?? schemastery.z ?? schemastery.default
  if (z && typeof z.object === 'function') {
    Config = z.object({
      role: z.string().default('preset'),
      host: z.boolean().default(true),
      modelsFile: z.string().default(''),
      modelSelector: z.string().default('replace'),
      applyModelOnAgent: z.boolean().default(true),
      applyModelOnCommand: z.boolean().default(true),
      applyModelOnSkill: z.boolean().default(true),
      applyDefaultLayer: z.boolean().default(true),
      command: z.string().default(''),
      timeoutMs: z.number().default(5000),
      resolveMode: z.string().default('capabilities'),
      autoActivate: z.boolean().default(true),
      namePrefix: z.string().default('capability'),
      maxCommandNameLength: z.number().default(48),
      skillRank: z.number().default(250),
      rules: z.boolean().default(true),
      skills: z.boolean().default(true),
      commands: z.boolean().default(true),
      agents: z.boolean().default(true),
      mcp: z.boolean().default(true),
      maxRulesBytes: z.number().default(65536),
      inventory: z.boolean().default(true),
      inventoryTextBytes: z.number().default(65536),
      defaultAgent: z.string().default(''),
    })
  }
} catch {
  // Plain Node tests and degraded compositions keep the defensive resolver.
}
export { Config }

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const PERSONA_SECTION_ORDER = 10150
const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'
/** Preset id this plugin is mounted under. */
const PRESET_ID = 'hnflow'
/** Management command for choosing a model layer. */
export const LAYER_COMMAND = 'capability-layer'

/**
 * Build the plan resolver every row uses.
 *
 * Switching a session to Capability initialises the workspace, so no manual
 * `hnflow-stack init` is needed; the first resolve of a project creates
 * `.hnflow/stack.json` through the CLI and then reads the plan.
 * @param {ReturnType<typeof resolveConfig>} config - resolved row config.
 * @param {{info?: Function, warn?: Function}} [logger] - plugin logger.
 * @returns {(cwd: string) => Promise<{plan: Record<string, unknown> | null, warnings: string[]}>} resolver for `PlanCache`.
 */
export function resolverFor(config, logger) {
  return async (cwd) => {
    const result = await activateAndResolve(cwd, config, {
      resolvePlan: (directory) => resolveProjectPlan(directory, config),
    })
    if (result.activation?.created) {
      try {
        logger?.info?.('capability: initialised %s', stackPath(cwd))
      } catch {
        // Logging must never break the mode.
      }
    }
    return result
  }
}

/**
 * Root row: provide `ctx.capability` and the model-layer settings route.
 * @param {Record<string, unknown>} ctx - Cordis plugin context.
 * @param {ReturnType<typeof resolveConfig>} config - resolved row config.
 * @param {{catalog?: object[], loadCatalog?: () => Promise<{layers: object[], bindings?: object, default: string | null, warnings: string[]}>}} [deps] - injectable catalog seam for tests.
 * @returns {CapabilityService} the service instance.
 */
export function applyCore(ctx, config, deps = {}) {
  const logger = ctx.logger
  const service = new CapabilityService({
    ctx,
    modelsFile: config.modelsFile,
    modelSelector: config.modelSelector,
    logger,
    catalog: deps.catalog,
  })
  const cache = new PlanCache(resolverFor(config, logger))
  // HNFlow reads the same resolved plan the capability rows inject: one source
  // of truth for groups and their `flows/` content.
  service.planFor = async (cwd) => {
    const result = await cache.get(cwd)
    return { plan: result.plan, warnings: result.warnings }
  }
  // Authors edit group content in place; drop the cached plan so the next
  // listing sees the new flow instead of waiting for stack.json to change.
  service.invalidatePlan = (cwd) => {
    cache.invalidate(cwd)
  }
  try {
    if (typeof ctx.provide === 'function') ctx.provide('capability', service)
  } catch (error) {
    logger?.warn?.('capability: cannot provide ctx.capability: %o', error)
  }

  const load = deps.loadCatalog ?? (() => loadCatalog(config.command, undefined, config.timeoutMs))
  service.catalogReady = (async () => {
    if (!Array.isArray(deps.catalog)) {
      try {
        const result = await load()
        for (const warning of result.warnings) logger?.warn?.('capability: %s', warning)
        service.setCatalog(result.layers)
        service.setPlatformBindings(result.bindings ?? {}, result.default)
      } catch (error) {
        logger?.warn?.('capability: cannot load the model layer catalog: %o', error)
      }
    }
    await service.reload()
  })()
  void service.catalogReady

  /**
   * Resolve the persona roster for one session without touching its log.
   *
   * The composer needs the roster before the first turn, but a session cannot
   * carry a surface event until the harness has written its first
   * `system/message` head. This read-only route lets the client fill that gap;
   * the authoritative publication still happens in `agent/pre-step`.
   * @param {string} sessionId - session id from the client.
   * @param {string} [hint] - workspace directory the client reports for the window.
   * @returns {Promise<object | null>} roster payload, or null when unavailable.
   */
  const rosterForSession = async (sessionId, hint) => {
    const cwd = await resolveSessionCwd(ctx, sessionId, hint)
    if (cwd === null) return null
    const result = await cache.get(cwd)
    for (const warning of result.warnings) logger?.warn?.('capability: %s', warning)
    const plan = result.plan
    if (!planUsable(plan)) return null
    const list = agentList(plan)
    const personas = personaAgents(list)
    return createRoster(list, pickDefaultAgent(personas, config.defaultAgent), plan.project)
  }

  /**
   * Resolve one session's plan and its project-relative working directory.
   *
   * The inventory panel shows exactly what the next step would load, so the
   * working directory comes from the session itself whenever the host knows it.
   * A window whose session has not been persisted yet only exists in the client,
   * so the client may send the workspace it belongs to; that hint is used last
   * and only when it names an existing absolute directory.
   * @param {string} sessionId - session id from the client.
   * @param {string} [hint] - workspace directory the client reports for the window.
   * @returns {Promise<{plan: object, cwd: string}>} plan and relative directory.
   * @throws {Error} with `code`/`status` when no directory can be determined.
   */
  const sessionForInventory = async (sessionId, hint) => {
    const cwd = await resolveSessionCwd(ctx, sessionId, hint)
    const candidates = []
    for (const candidate of [cwd, existingDirectory(hint)]) {
      if (candidate !== null && !candidates.includes(candidate)) candidates.push(candidate)
    }
    if (candidates.length === 0) {
      const missing = new Error(
        'this window has no session on the host yet, so its workspace is unknown: send one message in it, or run `hnflow-stack preview --project <path>` for the same view',
      )
      missing.code = 'missing-session'
      missing.status = 404
      missing.details = diagnoseSessionCwd(ctx)
      throw missing
    }
    const tried = []
    let reason = null
    /** @type {string[]} */
    const warnings = []
    for (const directory of candidates) {
      const result = await cache.get(directory)
      for (const warning of result.warnings) {
        if (!warnings.includes(warning)) warnings.push(warning)
        logger?.warn?.('capability: %s', warning)
      }
      if (planUsable(result.plan)) {
        return { plan: result.plan, cwd: relativeTo(result.plan.project, directory) }
      }
      reason = unusablePlanReason(result.plan)
      tried.push(directory)
    }
    const unusable = new Error(
      `no usable Capability plan for ${tried.join(' or ')}${reason === null ? '' : ` (${reason})`}`,
    )
    unusable.code = 'missing-plan'
    unusable.status = 404
    unusable.details = { cwd: tried, reason, warnings }
    throw unusable
  }

  /**
   * Make one window's workspace ready for the mode.
   *
   * Selecting the HNFlow preset should not leave the composer and the preview
   * waiting for a plan: this resolves (and, when allowed, initialises with
   * `hnflow-stack init`) the workspace the session belongs to, exactly once,
   * and reports why it could not so the client can show the real reason.
   * @param {string} sessionId - session id from the client.
   * @param {string} [hint] - workspace directory the client reports for the window.
   * @returns {Promise<{ready: boolean, cwd: string | null, project?: string, created?: boolean, reason?: string, warnings: string[]}>} report.
   */
  const prepareForSession = async (sessionId, hint) => {
    const cwd = await resolveSessionCwd(ctx, sessionId, hint)
    const candidates = []
    for (const candidate of [cwd, existingDirectory(hint)]) {
      if (candidate !== null && !candidates.includes(candidate)) candidates.push(candidate)
    }
    /** @type {string[]} */
    const warnings = []
    let reason = null
    for (const directory of candidates) {
      const result = await cache.get(directory)
      for (const warning of result.warnings) {
        if (!warnings.includes(warning)) warnings.push(warning)
        logger?.warn?.('capability: %s', warning)
      }
      if (planUsable(result.plan)) {
        return {
          ready: true,
          created: result.activation?.created === true,
          cwd: relativeTo(result.plan.project, directory),
          project: typeof result.plan.project === 'string' ? result.plan.project : directory,
          warnings,
        }
      }
      reason = unusablePlanReason(result.plan)
    }
    return {
      ready: false,
      cwd: candidates[0] ?? null,
      reason: reason ?? 'this window has no workspace on the host yet',
      warnings,
    }
  }

  ctx.inject(['connection'], (scope) => {
    try {
      const registry = scope.connection?.fetch
      if (typeof registry?.register !== 'function') {
        logger?.warn?.('capability: no Fetch route registry; roster and model settings stay file-only')
        return
      }
      registry.register(createModelsRoute({ service }))
      registry.register(createRosterRoute({ rosterForSession }))
      // The client calls this the moment a window switches to the mode, so the
      // workspace is initialised before the composer and the preview ask for it.
      registry.register(createPrepareRoute({ prepareForSession }))
      if (config.inventory !== false) {
        for (const route of createInventoryRoutes({
          sessionFor: sessionForInventory,
          maxRulesBytes: config.maxRulesBytes,
          textBytes: config.inventoryTextBytes,
        })) {
          registry.register(route)
        }
      }
    } catch (error) {
      logger?.warn?.('capability: cannot register a Fetch route: %o', error)
    }
  })
  ctx.effect(() => () => cache.clear(), 'capability: release the roster plan cache')
  return service
}

/**
 * Register the HNFlow mode.
 * @param {Record<string, unknown>} ctx - Cordis plugin context.
 * @param {unknown} rawConfig - row config.
 * @param {{resolvePlan?: (cwd: string) => Promise<{plan: Record<string, unknown> | null, warnings: string[]}>}} [deps] - injectable seams for tests.
 * @returns {void}
 */
export function apply(ctx, rawConfig, deps = {}) {
  const config = resolveConfig(rawConfig)
  // UI rows own no host behaviour.
  if (!config.host || config.role === 'ui') return
  // The root core row provides `ctx.capability` and the settings route; it must
  // not resolve projects or touch a session.
  if (config.role === 'core') {
    applyCore(ctx, config, deps)
    return
  }

  const resolveFor = deps.resolvePlan ?? resolverFor(config, ctx.logger)
  const cache = new PlanCache(resolveFor)
  /** Namespace options applied to every command and skill. */
  const names = {
    prefix: config.namePrefix,
    maxLength: config.maxCommandNameLength,
    rank: config.skillRank,
  }
  /** @type {{commands: Map<string, string>, mcpStores: Set<Map<string, {signature: string, fiber: unknown}>>, mcpModule: unknown, warned: Set<string>, sessions: WeakMap<object, {digest: string, mcp: Map<string, {signature: string, fiber: unknown}>}>, defaults: WeakSet<object>, skills: WeakMap<object, Set<string>>}} */
  const state = {
    commands: new Map(),
    mcpStores: new Set(),
    mcpModule: null,
    warned: new Set(),
    sessions: new WeakMap(),
    defaults: new WeakSet(),
    skills: new WeakMap(),
  }

  /** @type {Record<string, Function> | undefined} */
  let commandsScope
  /** Cached DSH message factory: function, null (not tried), or false (unavailable). */
  let harnessUserMessage = null

  const logger = ctx.logger
  const warn = (message, ...args) => {
    try {
      logger?.warn?.(message, ...args)
    } catch {
      // Logging must never break the mode.
    }
  }

  /**
   * Log each distinct resolver warning once.
   * @param {string[]} warnings - resolver warnings.
   * @returns {void}
   */
  const logWarnings = (warnings) => {
    for (const message of warnings) {
      if (state.warned.has(message)) continue
      state.warned.add(message)
      warn('capability: %s', message)
    }
  }

  /**
   * Build a user message with the harness factory when it is reachable.
   *
   * The local fallback keeps tests and degraded compositions working; once the
   * harness module fails, later calls go straight to the fallback.
   * @param {Record<string, unknown>} input - message body.
   * @returns {Promise<object>} frozen user message.
   */
  const userMessage = async (input) => {
    if (typeof harnessUserMessage === 'function') return harnessUserMessage(input)
    if (harnessUserMessage !== false) {
      try {
        const module = await loadHarnessModule(ctx, '@deepseek-ai/dsh-llm')
        const factory = module?.createUserMessage
        if (typeof factory === 'function') {
          harnessUserMessage = factory
          return factory(input)
        }
      } catch {
        // Fall through to the local shape.
      }
      harnessUserMessage = false
    }
    return createLocalUserMessage(input)
  }

  /**
   * Read the root service without requiring it.
   * @returns {CapabilityService | undefined} service when the core row is mounted.
   */
  const layerService = () => {
    try {
      return ctx.get('capability')
    } catch {
      return undefined
    }
  }

  /**
   * Apply one model layer to a session.
   *
   * The layer only changes the route; failure never blocks the prompt or the
   * persona switch that asked for it.
   * @param {object} agent - agent handle carrying a session.
   * @param {unknown} layerId - layer id.
   * @param {string} source - diagnostic source (`agent` / `command` / `skill`).
   * @returns {Promise<{ok: boolean, code?: string, layer?: object}>} outcome.
   */
  const applyModelFor = async (agent, layerId, source) => {
    const id = typeof layerId === 'string' ? layerId.trim() : ''
    if (id.length === 0) return { ok: true }
    const service = layerService()
    if (service === undefined) {
      warn('capability: model layer %s ignored (%s): ctx.capability is unavailable', id, source)
      return { ok: false, code: 'layers-unavailable' }
    }
    const layer = service.resolveLayer(id)
    if (layer === undefined) {
      const known = typeof service.hasLayer === 'function' && service.hasLayer(id)
      warn(
        'capability: model layer %s ignored (%s): %s',
        id,
        source,
        known ? 'layer is not bound on this machine' : 'unknown layer',
      )
      return { ok: false, code: known ? 'layer-unbound' : 'layer-unknown' }
    }
    const controller = ctx.get('sessionController')
    if (typeof controller?.selectModel !== 'function') {
      warn('capability: model layer %s ignored (%s): sessionController.selectModel is unavailable', id, source)
      return { ok: false, code: 'model-selection-unavailable' }
    }
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      warn('capability: model layer %s ignored (%s): session has no id', id, source)
      return { ok: false, code: 'session-unavailable' }
    }
    try {
      await controller.selectModel({
        sessionId,
        provider: layer.provider,
        model: layer.model,
        ...(layer.reasoningEffort === undefined ? {} : { reasoningEffort: layer.reasoningEffort }),
      })
      return { ok: true, layer }
    } catch (error) {
      warn('capability: model layer %s could not be applied (%s): %o', id, source, error)
      return { ok: false, code: 'layer-unroutable', layer }
    }
  }

  /**
   * Find the layer that matches a session's current model projection.
   * @param {object} service - layer service.
   * @param {object | undefined} selection - projected `{provider, model, reasoningEffort?}`.
   * @returns {object | undefined} matching layer.
   */
  const layerForSelection = (service, selection) => {
    if (!selection || typeof selection !== 'object') return undefined
    return service.listLayers().find((layer) => (
      layer.provider === selection.provider &&
      layer.model === selection.model &&
      (layer.reasoningEffort ?? '') === (selection.reasoningEffort ?? '')
    ))
  }

  /**
   * Read the session's current model selection projection.
   * @param {object} session - agent session.
   * @returns {object | undefined} projected selection.
   */
  const selectionOf = (session) => {
    const projections = ctx.get('sessionProjections')
    try {
      const value = projections?.stateOf?.(session, 'modelSelection')
      return value?.next ?? value?.current ?? value
    } catch {
      return undefined
    }
  }

  /**
   * Read the plugin's own per-session state record.
   * @param {object} session - agent session.
   * @returns {{digest: string, mcp: Map<string, {signature: string, fiber: unknown}>}} mutable record.
   */
  const sessionStateFor = (session) => {
    let record = state.sessions.get(session)
    if (record === undefined) {
      record = { digest: '', mcp: new Map() }
      state.sessions.set(session, record)
      state.mcpStores.add(record.mcp)
    }
    return record
  }

  /**
   * Whether the session already carries this exact instructions publication.
   * @param {object} session - agent session.
   * @param {string} digest - rendered rules digest.
   * @param {string} rosterKey - roster identity (empty when agents are off).
   * @returns {boolean} true when a matching message is already in history.
   */
  const surfaceHasPublication = (session, digest, rosterKey) => {
    const nodes = session?.surface?.nodes
    if (!Array.isArray(nodes) || typeof session?.eventAt !== 'function') return false
    for (const seq of [...nodes].reverse()) {
      const event = session.eventAt(seq)
      if (!event || event.type !== 'user/message') continue
      const source = event.data?.source
      if (!source || source.kind !== 'capability') continue
      if (source.digest !== digest) continue
      const published = typeof source.roster?.key === 'string' ? source.roster.key : ''
      if (published === rosterKey) return true
    }
    return false
  }

  /**
   * Read the session's effective working directory.
   * @param {object} session - session handle.
   * @returns {string | null} absolute directory, or null when unknown.
   */
  const cwdOf = (session) => {
    const workingDirectory = ctx.get('workingDirectory')
    let cwd
    try {
      cwd = workingDirectory?.get?.(session)
    } catch {
      return null
    }
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : null
  }

  /**
   * Read the session's persona: its own selection, else the configured default.
   *
   * The selection lives in the projection, which folds `/capability-agent`
   * invocations; a session that never selected one still runs the default.
   * @param {object} session - session handle.
   * @param {{name: string}[]} list - persona candidates for the current plan.
   * @returns {string | null} effective agent name.
   */
  const selectedOf = (session, list) => {
    const projections = ctx.get('sessionProjections')
    let state
    try {
      state = projections?.stateOf?.(session, PROJECTION_KEY)
    } catch {
      state = undefined
    }
    const current = typeof state?.selected === 'string' ? state.selected : null
    const personas = personaAgents(list)
    if (current !== null && personas.some((agent) => agent.name === current)) return current
    return pickDefaultAgent(personas, config.defaultAgent)
  }

  /**
   * Read the current workspace plan for a command invocation.
   * @param {object | undefined} agent - command agent handle.
   * @returns {Promise<{plan: Record<string, unknown> | null, cwd: string | null}>} current plan and cwd.
   */
  const currentPlanFor = async (agent) => {
    const session = agent?.session
    if (session === undefined || session === null) return { plan: null, cwd: null }
    const cwd = cwdOf(session)
    if (cwd === null) return { plan: null, cwd: null }
    const result = await cache.get(cwd)
    logWarnings(result.warnings)
    return { plan: result.plan, cwd }
  }

  /**
   * Register plan commands that are not registered yet.
   *
   * The canonical name is stable across projects, so a command is registered
   * once and the handler re-reads the current workspace before rendering. That
   * keeps a domain command from running in a project that does not activate its
   * group while Core commands remain available everywhere.
   * @param {Record<string, unknown>} plan - resolved plan.
   * @returns {void}
   */
  const syncCommands = (plan) => {
    if (!config.commands || commandsScope === undefined) return
    const project = typeof plan.project === 'string' ? plan.project : ''
    const warnings = []
    const entries = commandEntries(plan, names, warnings)
    const skillNames = new Set(skillCandidates(plan, names).map((skill) => skill.name))
    for (const entry of entries) {
      if (skillNames.has(entry.canonical)) {
        warnings.push(`command ${entry.canonical} shadows a skill with the same name`)
      }
      if (state.commands.has(entry.canonical)) continue
      try {
        commandsScope.commands.register({
          name: entry.canonical,
          description: entry.description,
          input: { hint: '[arguments]' },
          handler: async (invocation) => {
            const agent = invocation?.agent
            const current = await currentPlanFor(agent)
            if (!planUsable(current.plan)) {
              return { kind: 'error', text: `HNFlow: ${unusablePlanReason(current.plan)}` }
            }
            const currentWarnings = []
            const live = commandEntries(current.plan, names, currentWarnings)
            logWarnings(currentWarnings)
            const entryNow = live.find((candidate) => candidate.canonical === entry.canonical)
            if (entryNow === undefined) {
              return {
                kind: 'error',
                text: `HNFlow: /${entry.canonical} 不属于当前工作区（未激活 ${entry.group} 能力组）`,
              }
            }
            const deliver = typeof agent?.followup === 'function'
              ? agent.followup.bind(agent)
              : typeof agent?.steer === 'function'
                ? agent.steer.bind(agent)
                : null
            if (deliver === null) {
              return { kind: 'error', text: 'HNFlow: 当前 Agent 不支持投递用户回合' }
            }
            if (config.applyModelOnCommand && entryNow.model.length > 0) {
              await applyModelFor(agent, entryNow.model, 'command')
            }
            const attachments = Array.isArray(invocation.attachments) ? invocation.attachments : []
            const text = renderTemplate(entryNow.template, invocation.rawInput)
            deliver(
              await userMessage({
                content: [...attachments, { type: 'text', text }],
                source: { kind: 'user' },
              }),
            )
            return { kind: 'success', text: `HNFlow: 已发送 /${entry.canonical}` }
          },
        })
        state.commands.set(entry.canonical, project)
      } catch (error) {
        state.commands.set(entry.canonical, project)
        warn('capability: cannot register command /%s: %o', entry.canonical, error)
      }
    }
    logWarnings(warnings)
  }

  /**
   * Reconcile the session's mounted MCP servers with its plan.
   *
   * Mounting happens under the agent's own context when the runtime exposes it,
   * so two sessions of the same preset generation with different projects do not
   * fight over one shared mount table.
   * @param {Record<string, unknown>} plan - resolved plan.
   * @param {object} agent - agent handle.
   * @returns {Promise<void>} resolves after reconciliation.
   */
  const syncMcp = async (plan, agent) => {
    if (!config.mcp) return
    const entries = normalizeMcpEntries(plan.mcp)
    const mountCtx = agent.ctx ?? ctx
    const store = sessionStateFor(agent.session).mcp
    await syncMcpServers(mountCtx, store, entries, async () => {
      if (state.mcpModule !== null) return state.mcpModule
      state.mcpModule = await loadHarnessModule(ctx, MCP_CLIENT_PACKAGE)
      return state.mcpModule
    })
  }

  /**
   * Inject the instructions message for this step, once per digest and roster.
   *
   * The roster travels in the message `source`: the harness stores the message
   * as a `user/message` event, the client projection folds it, and the model
   * only sees the rule text. No plugin-owned event type is ever written.
   * @param {object} agent - agent handle.
   * @param {Record<string, unknown>} plan - resolved plan.
   * @param {string} [relative] - working directory relative to the project root.
   * @returns {Promise<Record<string, unknown> | null>} message to append, or null.
   */
  const injectInstructions = async (agent, plan, relative = '') => {
    if (!config.rules) return null
    const rendered = await renderRules(plan, { maxBytes: config.maxRulesBytes, cwd: relative })
    if (rendered === null) return null
    /** @type {{key: string, agents: object[], project: string, defaultSelected: string | null, version: number} | null} */
    let roster = null
    if (config.agents) {
      // Publish every agent so subagent sessions can inspect the full union;
      // the left persona menu lists primary/all.
      const list = agentList(plan)
      const personas = personaAgents(list)
      roster = createRoster(list, pickDefaultAgent(personas, config.defaultAgent), plan.project)
    }
    const key = roster?.key ?? ''
    const stamp = `${rendered.digest}:${key}`
    const record = sessionStateFor(agent.session)
    if (record.digest === stamp) return null
    if (surfaceHasPublication(agent.session, rendered.digest, key)) {
      record.digest = stamp
      return null
    }
    record.digest = stamp
    const source = { kind: 'capability', form: 'instructions', digest: rendered.digest }
    if (roster !== null) source.roster = roster
    return userMessage({
      content: [{ type: 'text', text: rendered.text }],
      source,
    })
  }

  /**
   * Apply `models.default` once to a session that has no recorded selection.
   * @param {object} agent - agent handle.
   * @returns {Promise<void>} resolves after the attempt.
   */
  const applyDefaultLayer = async (agent) => {
    if (!config.applyDefaultLayer) return
    const service = layerService()
    if (service === undefined) return
    if (state.defaults.has(agent.session)) return
    state.defaults.add(agent.session)
    if (selectionOf(agent.session) !== undefined) return
    const id = service.defaultLayer()
    if (id === null || id === undefined || String(id).length === 0) return
    await applyModelFor(agent, id, 'default')
  }

  /**
   * Apply layers named by `/capability-...` skill tokens in this step's input.
   *
   * Best effort: `dsh-tool-skill` owns the actual skill injection; a layer may
   * take effect on the next request depending on listener order.
   * @param {object} agent - agent handle.
   * @param {Record<string, unknown>} plan - resolved plan.
   * @param {object[]} messages - messages offered to this step.
   * @returns {Promise<void>} resolves after each attempt.
   */
  const applySkillLayers = async (agent, plan, messages) => {
    if (!config.applyModelOnSkill || !Array.isArray(messages) || messages.length === 0) return
    const candidates = skillCandidates(plan, names).filter((skill) => skill.model.length > 0)
    if (candidates.length === 0) return
    let applied = state.skills.get(agent.session)
    if (applied === undefined) {
      applied = new Set()
      state.skills.set(agent.session, applied)
    }
    for (const message of messages) {
      if (message?.role !== 'user') continue
      const text = (Array.isArray(message.content) ? message.content : [])
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
      if (text.length === 0) continue
      const tokens = new Set(text.match(/\/[a-z0-9][a-z0-9_-]*/gu) ?? [])
      for (const skill of candidates) {
        if (applied.has(skill.name)) continue
        if (!tokens.has(`/${skill.name}`)) continue
        applied.add(skill.name)
        await applyModelFor(agent, skill.model, 'skill')
      }
    }
  }

  /**
   * Resolve the mode's work for one agent step.
   * @param {object} agent - agent handle.
   * @param {AbortSignal | undefined} signal - step signal.
   * @param {object[]} [messages] - messages offered to this step.
   * @returns {Promise<Record<string, unknown> | null>} message to add to the step.
   */
  const prepare = async (agent, signal, messages = []) => {
    const workingDirectory = ctx.get('workingDirectory')
    if (workingDirectory?.ensure === undefined) return null
    const cwd = await workingDirectory.ensure(agent, signal)
    if (typeof cwd !== 'string' || cwd.length === 0) return null
    const result = await cache.get(cwd)
    logWarnings(result.warnings)
    const plan = result.plan
    if (!planUsable(plan)) return null
    syncCommands(plan)
    try {
      await syncMcp(plan, agent)
    } catch (error) {
      // An unavailable MCP server must not suppress rules, skills, commands or
      // the Agent roster; the step still starts with everything else.
      warn('capability: MCP sync failed: %o', error)
    }
    await applyDefaultLayer(agent)
    await applySkillLayers(agent, plan, messages)
    return injectInstructions(agent, plan, relativeTo(plan.project, cwd))
  }

  /** Sessions with a preset-binding prime already in flight. */
  const priming = new WeakSet()

  /**
   * Resolve the plan and register commands when the preset is bound.
   *
   * This deliberately writes nothing to the session: a surface event appended
   * before the harness's first `system/message` violates the stored session
   * format. The roster reaches the client through the read-only core route;
   * `agent/pre-step` publishes it durably once the step has opened.
   * @param {object} session - session handle.
   * @returns {Promise<void>} resolves after the attempt.
   */
  const prime = (session, sessionId) => {
    if (!config.agents || session === undefined || session === null) return Promise.resolve()
    if (priming.has(session)) return Promise.resolve()
    priming.add(session)
    return (async () => {
      try {
        // A session that has not written its first message yet has no handle
        // directory, but the host still knows which workspace it belongs to.
        // Falling back to that is what lets the mode initialise the workspace
        // the moment the preset is selected.
        const id = typeof sessionId === 'string'
          ? sessionId
          : typeof session?.id === 'string'
            ? session.id
            : typeof session?.sessionId === 'string'
              ? session.sessionId
              : undefined
        let cwd = cwdOf(session)
        if (cwd === null && id !== undefined) cwd = await resolveSessionCwd(ctx, id, undefined)
        if (cwd === null) return
        const result = await cache.get(cwd)
        logWarnings(result.warnings)
        const plan = result.plan
        if (!planUsable(plan)) return
        syncCommands(plan)
      } catch (error) {
        warn('capability: cannot prime the preset: %o', error)
      } finally {
        priming.delete(session)
      }
    })()
  }

  /**
   * Resolve a session handle from a preset id or an event payload.
   * @param {unknown} value - id or session/payload.
   * @returns {object | null} session handle.
   */
  const sessionFrom = (value) => {
    if (value && typeof value === 'object' && value.session) return value.session
    if (value && typeof value === 'object' && typeof value.append === 'function') return value
    if (typeof value !== 'string') return null
    try {
      const agents = ctx.get('agents')
      const fromAgent = agents?.get?.(value)?.session
      if (fromAgent !== undefined && fromAgent !== null) return fromAgent
      return ctx.get('sessions')?.get?.(value) ?? null
    } catch {
      return null
    }
  }

  const onPresetSelected = (first, second) => {
    const sessionId = typeof first === 'string'
      ? first
      : first?.sessionId ?? first?.session?.id ?? first?.id
    const preset = typeof first === 'string'
      ? second
      : first?.agentPreset ?? first?.preset
    if (preset !== PRESET_ID) return undefined
    const session = sessionFrom(sessionId)
    if (session === null) return undefined
    return prime(session, sessionId)
  }

  ctx.on('agent-preset/selected', onPresetSelected)
  ctx.on('session/event', (session, event) => {
    if (!config.agents || event?.type !== 'agent-preset/selected') return undefined
    if (event.data?.agentPreset !== PRESET_ID) return undefined
    return prime(session, session?.id)
  })
  ctx.on('agent/created', (payload) => {
    if (!config.agents) return undefined
    const session = sessionFrom(payload?.agent)
    if (session === null) return undefined
    void prime(session)
    return undefined
  })

  ctx.inject(['sessionProjections'], (scope) => {
    if (!config.agents) return
    try {
      scope.sessionProjections.register(createProjectionDefinition())
    } catch (error) {
      warn('capability: cannot register the agent projection: %o', error)
    }
  })

  ctx.inject(['systemPrompt'], (scope) => {
    if (!config.agents) return
    try {
      scope.systemPrompt.section({
        name: 'capability:agent',
        order: PERSONA_SECTION_ORDER,
        text: (assembly) => {
          const agent = assembly?.agent
          if (agent === undefined) return ''
          const cwd = cwdOf(agent.session)
          const plan = cwd === null ? null : cache.peek(cwd)
          if (!planUsable(plan)) return ''
          const list = agentList(plan)
          const selected = selectedOf(agent.session, list)
          if (selected === null) return ''
          const entry = list.find((candidate) => candidate.name === selected)
          if (entry === undefined || entry.system.trim().length === 0) return ''
          return `You are acting as the Capability agent "${entry.name}".\n\n${entry.system.trim()}`
        },
      })
    } catch (error) {
      warn('capability: cannot register the agent section: %o', error)
    }
  })

  ctx.inject(['skills'], (scope) => {
    if (!config.skills) return
    try {
      scope.skills.registerProvider(() =>
        createSkillProvider({
          getPlan: async (cwd) => (await cache.get(cwd)).plan,
          names,
          isUsable: planUsable,
        }),
      )
    } catch (error) {
      warn('capability: cannot register the skill provider: %o', error)
    }
    void (async () => {
      try {
        const text = await readFile(path.join(PLUGIN_DIR, 'skills', 'capability', 'SKILL.md'), 'utf8')
        const skill = readSkillFile(text)
        if (skill.name.length === 0 || skill.description.length === 0) return
        scope.skills.register({ name: skill.name, description: skill.description, content: skill.content, source: 'bundled' })
      } catch (error) {
        warn('capability: cannot load the bundled skill: %o', error)
      }
    })()
  })

  ctx.inject(['commands'], (scope) => {
    if (!config.commands) return
    commandsScope = scope
    try {
      scope.commands.register({
        name: SELECT_COMMAND,
        description: '选择本会话的 HNFlow Agent（人设）',
        input: { hint: '[agent 名称|list]' },
        handler: async ({ agent, rawInput }) => {
          const cwd = cwdOf(agent.session)
          const result = cwd === null ? null : await cache.get(cwd)
          if (result !== null) logWarnings(result.warnings)
          const plan = result?.plan ?? null
          const agents = planUsable(plan) ? personaAgents(agentList(plan)) : []
          if (agents.length === 0) {
            return { kind: 'error', text: 'HNFlow: 当前项目没有可选 Agent（先在该项目激活能力组）' }
          }
          const input = String(rawInput ?? '').trim()
          if (input.length === 0 || input === 'list') {
            const names = agents.map((entry) => entry.name).join(', ')
            return { kind: 'success', text: `Capability agents: ${names}（当前：${selectedOf(agent.session, agents) ?? '未选择'}）` }
          }
          const match = agents.find((entry) => entry.name.toLowerCase() === input.toLowerCase())
          if (match === undefined) {
            return { kind: 'error', text: `HNFlow: 未找到 agent "${input}"` }
          }
          if (config.applyModelOnAgent && typeof match.model === 'string' && match.model.length > 0) {
            await applyModelFor(agent, match.model, 'agent')
          }
          // The command executor logs `command/run` before this handler runs, so
          // the projection already folded the new selection.
          return { kind: 'success', text: `HNFlow: 已切换 Agent 为 ${match.name}` }
        },
      })
    } catch (error) {
      warn('capability: cannot register /%s: %o', SELECT_COMMAND, error)
    }
    try {
      scope.commands.register({
        name: LAYER_COMMAND,
        description: '选择本会话的模型层（Capability 用户级路由）',
        input: { hint: '[layer 名称|list]' },
        handler: async ({ agent, rawInput }) => {
          const service = layerService()
          if (service === undefined) {
            return { kind: 'error', text: 'HNFlow: 模型层服务未加载（缺少 capability-core 行）' }
          }
          const layers = service.listCatalog()
          if (layers.length === 0) {
            return { kind: 'error', text: 'HNFlow: 模型层目录不可用（检查 hnflow-stack 安装与版本）' }
          }
          const input = String(rawInput ?? '').trim()
          const current = layerForSelection(service, selectionOf(agent.session))
          if (input.length === 0 || input === 'list') {
            const names = layers
              .map((layer) => `${layer.id}（${layer.label}${layer.bound === false ? '，未绑定' : ''}）`)
              .join(', ')
            return {
              kind: 'success',
              text: `Capability layers: ${names}（当前：${current?.id ?? '未映射'}）`,
            }
          }
          const match = layers.find((layer) => layer.id.toLowerCase() === input.toLowerCase())
          if (match === undefined) {
            return { kind: 'error', text: `HNFlow: 未找到模型层 "${input}"` }
          }
          if (match.bound === false) {
            return { kind: 'error', text: `HNFlow: 模型层 ${match.id} 尚未绑定本机模型（在设置页配置）` }
          }
          const applied = await applyModelFor(agent, match.id, 'layer-command')
          if (!applied.ok) {
            return { kind: 'error', text: `HNFlow: 无法应用模型层 ${match.id}（${applied.code}）` }
          }
          return { kind: 'success', text: `HNFlow: 已切换模型层为 ${match.id}（${match.label}）` }
        },
      })
    } catch (error) {
      warn('capability: cannot register /%s: %o', LAYER_COMMAND, error)
    }
  })

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    try {
      if (decision?.kind === 'reject' || signal?.aborted === true) return decision
      const message = await prepare(agent, signal, decision.messages ?? [])
      if (message === null) return decision
      return { ...decision, messages: [...(decision.messages ?? []), message] }
    } catch (error) {
      warn('capability: pre-step failed: %o', error)
      return decision
    }
  })

  ctx.effect(() => () => {
    for (const store of state.mcpStores) {
      for (const mounted of store.values()) {
        void Promise.resolve(mounted.fiber?.dispose?.()).catch(() => {})
      }
      store.clear()
    }
    state.mcpStores.clear()
    cache.clear()
  }, 'capability: release cached plans and MCP servers')
}

/**
 * Import a harness package the way the Loader does, falling back to plain ESM.
 *
 * A linked bundle lives outside the harness `node_modules`, so a bare import may
 * not resolve through Node alone. The Loader's internal importer applies the
 * harness resolution rules; the plain import keeps the module usable in tests.
 * @param {Record<string, unknown>} ctx - plugin context.
 * @param {string} specifier - package specifier.
 * @returns {Promise<Record<string, unknown>>} module namespace.
 */
async function loadHarnessModule(ctx, specifier) {
  const loader = ctx.get('loader')
  const internal = loader?.internal
  if (typeof internal?.import === 'function') {
    try {
      return await internal.import(specifier, new URL('./', import.meta.url).href, {})
    } catch {
      // Fall through to the plain resolver.
    }
  }
  return await import(specifier)
}
