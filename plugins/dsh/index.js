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
import { createRoutes } from './lib/routes.js'
import { createService } from './lib/service.js'
import { readSkillFile } from './lib/skill.js'
import { createFlowTool } from './lib/tools.js'

/** Plugin name shown in Loader diagnostics. */
export const name = 'hnflow'

/** Prompt-section order: after first-party guidance, before persona suffix. */
const SECTION_ORDER = 10160

/** Bundled skill file, resolved next to this module. */
const SKILL_FILE = fileURLToPath(new URL('./skills/hnflow-flows/SKILL.md', import.meta.url))

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
    applyCore(ctx, config)
    return
  }
  if (config.role !== 'preset') return
  applyPreset(ctx, config)
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
  // `/hnflow` is global: listing, assets and publish use the workspace of the
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
        try {
          const skill = readSkillFile(await readFile(SKILL_FILE, 'utf8'))
          if (skill.name.length === 0 || skill.description.length === 0) {
            logger?.warn?.('hnflow: the bundled skill has no name/description frontmatter; skipping')
            return
          }
          skillsScope.skills.register({ name: skill.name, description: skill.description, content: skill.content, source: 'bundled' })
        } catch (error) {
          logger?.warn?.('hnflow: cannot load the bundled skill: %o', error)
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
