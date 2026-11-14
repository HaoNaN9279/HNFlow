/**
 * HNFlow for DeepSeek Harness.
 *
 * Three rows, one plugin:
 *
 * - `hnflow-core` (root): provides `ctx.hnflow`, the orchestrator, and the
 *   Fetch routes the page and the notice read. It owns no session behaviour and
 *   its service is a singleton for the whole host.
 * - `hnflow` (inside the `hnflow` preset): the model-facing surface — the
 *   `hnflow` / `hnflow_author` tools, `/hnflow`, the `hnflow-flows` skill and
 *   the flow index in the system prompt. It never publishes.
 * - `hnflow-ui` (host:false): the browser bundle, whose page reads the routes.
 *
 * Everything a session does goes through the same service as the page, so the
 * page and the conversation cannot disagree about a run.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { createFlowCommand } from './lib/commands.js'
import { createAuthorTool } from './lib/author.js'
import { PLUGIN_VERSION, resolveConfig } from './lib/config.js'
import { writeBreadcrumb } from './lib/diagnostics.js'
import { capabilityAvailable, capabilityOf, capabilityWarnings } from './lib/layers.js'
import { createRoutes } from './lib/routes.js'
import { createService } from './lib/service.js'
import { readSkillFile } from './lib/skill.js'
import { createFlowTool } from './lib/tools.js'
import { apply as applyCapability, applyCore as applyCapabilityCore } from './capability/index.js'

/** Plugin name shown in Loader diagnostics. */
export const name = 'hnflow'

/** Prompt-section order: after first-party guidance, before persona suffix. */
const SECTION_ORDER = 10160

/** Bundled skill files, resolved next to this module. */
const SKILL_FILES = Object.freeze([
  fileURLToPath(new URL('./skills/hnflow-controls/SKILL.md', import.meta.url)),
  fileURLToPath(new URL('./skills/hnflow-flows/SKILL.md', import.meta.url)),
])

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
      host: z.boolean().default(true),
      role: z.string().default('preset'),
      libraryRoot: z.string().default(''),
      workspaceDir: z.string().default('.hnflow'),
      stateDir: z.string().default(''),
      presetAllowlist: z.array(z.string()).default(['hnflow', 'standard']),
      maxParallel: z.number().default(3),
      maxAttempts: z.number().default(2),
      nodeTimeoutMs: z.number().default(900000),
      maxIndexEntries: z.number().default(20),
      storage: z.boolean().default(true),
      passIntervalMs: z.number().default(2000),
      runBudgetMs: z.number().default(21600000),
      resumeOnStart: z.boolean().default(true),
      outboxMaxAttempts: z.number().default(8),
      triggersEnabled: z.boolean().default(true),
      resolveMode: z.string().default('capabilities'),
      autoActivate: z.boolean().default(true),
      namePrefix: z.string().default('capability'),
      modelSelector: z.string().default('replace'),
      applyModelOnAgent: z.boolean().default(true),
      applyModelOnCommand: z.boolean().default(true),
      applyModelOnSkill: z.boolean().default(true),
      applyDefaultLayer: z.boolean().default(true),
      capabilityRules: z.boolean().default(true),
      capabilitySkills: z.boolean().default(true),
      capabilityCommands: z.boolean().default(true),
      capabilityAgents: z.boolean().default(true),
      capabilityMcp: z.boolean().default(true),
      inventory: z.boolean().default(true),
      inventoryTextBytes: z.number().default(65536),
      defaultAgent: z.string().default(''),
      modelsFile: z.string().default(''),
      command: z.string().default(''),
      timeoutMs: z.number().default(5000),
      maxRulesBytes: z.number().default(65536),
      maxCommandNameLength: z.number().default(48),
      skillRank: z.number().default(250),
    })
  }
} catch {
  // Plain Node tests and degraded compositions keep the defensive resolver.
}
export { Config }

/**
 * Register the HNFlow rows.
 * @param {Record<string, any>} ctx - Cordis plugin context.
 * @param {unknown} rawConfig - row config.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  // UI rows own no host behaviour at all.
  if (config.host === false) return
  if (config.role === 'core') {
    try {
      applyCapabilityCore(ctx, { ...config, role: 'core', host: true })
    } catch (error) {
      ctx.logger?.warn?.('hnflow: capability core failed; model layers and preview stay unavailable: %o', error)
    }
    applyCore(ctx, config)
    return
  }
  if (config.role === 'pass') {
    applyPass(ctx, config)
    return
  }
  if (config.role !== 'preset') return
  applyPreset(ctx, config)
  try {
    applyCapability(ctx, {
      ...config,
      role: 'preset',
      host: true,
      rules: config.capabilityRules,
      skills: config.capabilitySkills,
      commands: config.capabilityCommands,
      agents: config.capabilityAgents,
      mcp: config.capabilityMcp,
    })
  } catch (error) {
    ctx.logger?.warn?.('hnflow: capability preset failed; capability content stays unavailable: %o', error)
  }
}

/**
 * Pass row: the clock.
 *
 * Deliberately its own row: the tick is the one thing that must keep running
 * when nobody is watching, and a crash in automation must not take the page or
 * the model surface with it. It never decides anything — it advances expiry,
 * replays durable effects, evaluates triggers and nudges stalled runs.
 * @param {Record<string, any>} ctx - Cordis plugin context.
 * @param {ReturnType<typeof resolveConfig>} config - resolved config.
 * @returns {void}
 */
export function applyPass(ctx, config) {
  const logger = ctx.logger
  void writeBreadcrumb('pass', { role: 'pass', version: PLUGIN_VERSION, intervalMs: config.passIntervalMs })
  ctx.inject(['hnflow'], (scope) => {
    const service = scope.hnflow
    if (service === undefined || service === null || typeof service.pass !== 'function') {
      logger?.warn?.('hnflow: the pass row found no orchestrator; automation stays off')
      void writeBreadcrumb('pass', { role: 'pass', version: PLUGIN_VERSION, phase: 'no-service' })
      return
    }
    /**
     * Run one pass.
     * @returns {void}
     */
    const tick = () => {
      void Promise.resolve(service.pass()).catch((error) => logger?.warn?.('hnflow: the pass failed: %o', error))
    }
    const timer = setInterval(tick, config.passIntervalMs)
    if (typeof timer.unref === 'function') timer.unref()
    // First tick soon after start: a restart may have left expiry and effects
    // waiting, and waiting a full interval for nothing is a needless delay.
    const first = setTimeout(tick, Math.min(config.passIntervalMs, 1000))
    if (typeof first.unref === 'function') first.unref()
    ctx.effect(
      () => () => {
        clearInterval(timer)
        clearTimeout(first)
        return undefined
      },
      'hnflow: stop the pass ticker',
    )
    void writeBreadcrumb('pass', { role: 'pass', version: PLUGIN_VERSION, phase: 'registered', intervalMs: config.passIntervalMs })
  })
}

/**
 * Root row: provide the orchestrator and the page routes.
 * @param {Record<string, any>} ctx - Cordis plugin context.
 * @param {ReturnType<typeof resolveConfig>} config - resolved config.
 * @returns {Record<string, any>} the service instance.
 */
export function applyCore(ctx, config) {
  const logger = ctx.logger
  /** @type {Record<string, any>} */
  let service
  try {
    service = createService({ ctx, config, logger })
  } catch (error) {
    // A broken core row would silently take the whole preset with it (no
    // service means the preset's injects never fire). Say so loudly and leave
    // a breadcrumb the user can hand back.
    logger?.error?.('hnflow: cannot construct the orchestrator; the HNFlow mode stays unavailable: %o', error)
    void writeBreadcrumb('core', { role: 'core', version: PLUGIN_VERSION, error: String(error?.message ?? error) })
    throw error
  }
  const facts = {
    role: 'core',
    version: PLUGIN_VERSION,
    storageDomain: safeHas(ctx, 'storageDomain'),
    subagents: safeHas(ctx, 'subagents'),
    presets: safeHas(ctx, 'agentPresets'),
    connection: safeHas(ctx, 'connection'),
    capability: capabilityFactsOf(ctx),
  }
  void writeBreadcrumb('core', facts)
  try {
    if (typeof ctx.provide === 'function') ctx.provide('hnflow', service)
    else logger?.warn?.('hnflow: this harness cannot provide services; the preset row will not find ctx.hnflow')
  } catch (error) {
    logger?.warn?.('hnflow: cannot provide ctx.hnflow: %o', error)
    void writeBreadcrumb('core', { ...facts, provideError: String(error?.message ?? error) })
  }
  void service.open().catch((error) => logger?.warn?.('hnflow: cannot open the run store: %o', error))
  ctx.inject(['connection'], (scope) => {
    const registry = scope.connection?.fetch
    if (typeof registry?.register !== 'function') {
      logger?.warn?.('hnflow: no Fetch route registry; the HNFlow page stays offline')
      void writeBreadcrumb('core', { ...facts, routes: 0, routeError: 'no fetch registry' })
      return
    }
    // One route failing must not take the others down with it: the page
    // degrades per surface, not as a whole.
    /** @type {{path: string, error: string}[]} */
    const routeErrors = []
    /** @type {string[]} */
    const registered = []
    for (const route of createRoutes({ service })) {
      try {
        registry.register(route)
        registered.push(route.path)
      } catch (error) {
        routeErrors.push({ path: route.path, error: String(error?.message ?? error) })
        logger?.warn?.('hnflow: cannot register the route %s: %o', route.path, error)
      }
    }
    void writeBreadcrumb('core', { ...facts, routes: registered.length, registered, routeErrors })
  })
  // `/hnflow` is global: listing and running flows use the workspace of the
  // session that typed it, and the command must exist outside HNFlow sessions
  // too (it is the human surface for the page's data).
  ctx.inject(['commands', 'workingDirectory'], (scope) => {
    try {
      /**
       * Workspace directory of the invoking session.
       * @param {unknown} agent - command's agent.
       * @returns {string | null} absolute path.
       */
      const cwdOf = (agent) => {
        try {
          const cwd = scope.workingDirectory?.get?.(/** @type {any} */ (agent)?.session)
          return typeof cwd === 'string' && cwd.length > 0 ? cwd : null
        } catch {
          return null
        }
      }
      scope.commands.register(createFlowCommand({ service, cwdOf, config, logger }))
      void writeBreadcrumb('commands', { role: 'core', version: PLUGIN_VERSION, phase: 'registered', name: 'hnflow' })
    } catch (error) {
      logger?.warn?.('hnflow: cannot register /hnflow: %o', error)
      void writeBreadcrumb('commands', { role: 'core', version: PLUGIN_VERSION, phase: 'error', error: String(error?.message ?? error) })
    }
  })
  ctx.effect(
    () => () => {
      void service.close()
      return undefined
    },
    'hnflow: stop the orchestrator and close its store',
  )
  return service
}

/**
 * Whether a service is readable without throwing.
 * @param {Record<string, any>} ctx - plugin context.
 * @param {string} name - service name.
 * @returns {boolean} true when `ctx.get(name)` yields a value.
 */
function safeHas(ctx, name) {
  try {
    return ctx.get?.(name) !== undefined
  } catch {
    return false
  }
}

/**
 * The Capability contract as seen at load time, for the breadcrumb.
 * @param {Record<string, any>} ctx - Cordis context.
 * @returns {{available: boolean, apiVersion: number | null, warnings: string[]}} facts.
 */
function capabilityFactsOf(ctx) {
  const service = capabilityOf(ctx)
  return {
    available: capabilityAvailable(service),
    apiVersion: service === undefined || service === null ? null : Number(service.apiVersion) || null,
    warnings: capabilityWarnings(service),
  }
}

/**
 * Preset row: the model-facing surface inside an HNFlow session.
 * @param {Record<string, any>} ctx - Cordis plugin context.
 * @param {ReturnType<typeof resolveConfig>} config - resolved config.
 * @returns {void}
 */
function applyPreset(ctx, config) {
  const logger = ctx.logger
  void writeBreadcrumb('preset', { role: 'preset', version: PLUGIN_VERSION, phase: 'started', service: safeHas(ctx, 'hnflow'), tools: safeHas(ctx, 'tools') })

  /**
   * Effective working directory of an agent session.
   * @param {unknown} agent - agent handle.
   * @returns {string | null} absolute path, or null when unknown.
   */
  const cwdOf = (agent) => {
    const handle = /** @type {{session?: object} | undefined} */ (agent ?? undefined)
    if (handle?.session === undefined) return null
    try {
      const cwd = ctx.get('workingDirectory')?.get?.(handle.session)
      return typeof cwd === 'string' && cwd.length > 0 ? cwd : null
    } catch {
      return null
    }
  }

  ctx.inject(['hnflow', 'tools'], (scope) => {
    try {
      scope.tools.register(createFlowTool({ service: scope.hnflow, cwdOf }))
      scope.tools.register(createAuthorTool({ service: scope.hnflow, cwdOf }))
      void writeBreadcrumb('preset', { role: 'preset', version: PLUGIN_VERSION, phase: 'ready', tools: 2 })
    } catch (error) {
      logger?.warn?.('hnflow: cannot register the flow tools: %o', error)
      void writeBreadcrumb('preset', { role: 'preset', version: PLUGIN_VERSION, phase: 'tool-error', error: String(error?.message ?? error) })
    }
  })

  ctx.inject(['hnflow'], (scope) => {
    const service = scope.hnflow
    ctx.inject(['skills'], (skillsScope) => {
      void (async () => {
        for (const skillFile of SKILL_FILES) {
          try {
            const skill = readSkillFile(await readFile(skillFile, 'utf8'))
            if (skill.name.length === 0 || skill.description.length === 0) {
              logger?.warn?.('hnflow: the bundled skill %s has no name/description frontmatter; skipping', skillFile)
              continue
            }
            skillsScope.skills.register({ name: skill.name, description: skill.description, content: skill.content, source: 'bundled' })
          } catch (error) {
            logger?.warn?.('hnflow: cannot load the bundled skill %s: %o', skillFile, error)
          }
        }
      })()
    })
    ctx.inject(['systemPrompt'], (promptScope) => {
      try {
        promptScope.systemPrompt.section({
          name: 'hnflow:flows',
          order: SECTION_ORDER,
          text: (assembly) => {
            const cwd = cwdOf(assembly?.agent)
            if (cwd === null) return ''
            return service.cachedIndex(cwd)
          },
        })
      } catch (error) {
        logger?.warn?.('hnflow: cannot register the flow prompt section: %o', error)
      }
    })
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        if (decision?.kind === 'reject' || payload?.signal?.aborted === true) return decision
        const cwd = cwdOf(payload?.agent)
        if (cwd !== null) await service.indexSection(cwd)
      } catch (error) {
        logger?.warn?.('hnflow: refreshing the flow index failed: %o', error)
      }
      return decision
    })
  })
}

/** Exported for tests and for the usage hint in plugin documentation. */
export { USAGE as COMMAND_USAGE } from './lib/commands.js'
