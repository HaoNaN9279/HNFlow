/**
 * HNFlow mode for DeepSeek Harness.
 *
 * The plugin is mounted as a child row of the `hnflow` agent preset, so every
 * registration — the `workflow` tool, the `/workflow` command family, and the
 * workflow index in the system prompt — belongs to that mode. The `vibestack`
 * mode keeps its capability groups and gains no workflow entry point.
 *
 * Everything here is failure-open: a missing interpreter, an unreadable
 * library, or an unexpected payload degrades to a log line, never to a broken
 * session.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { USAGE, createWorkflowCommand } from './lib/commands.js'
import { createWorkflowAuthorTool } from './lib/author.js'
import { HnflowService } from './lib/service.js'
import { readSkillFile } from './lib/skill.js'
import { createWorkflowTool } from './lib/tools.js'

/** Plugin name shown in Loader diagnostics. */
export const name = 'hnflow'

/** Prompt-section order: after first-party guidance, before persona suffix. */
const SECTION_ORDER = 10160

/** Bundled skill file, resolved next to this module. */
const SKILL_FILE = fileURLToPath(new URL('./skills/hnflow-workflow/SKILL.md', import.meta.url))

/**
 * Register the HNFlow mode.
 * @param {Record<string, unknown>} ctx - Cordis plugin context.
 * @param {unknown} rawConfig - row config.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const logger = ctx.logger
  /**
   * Warn without ever throwing from the plugin body.
   * @param {string} message - format string.
   * @param {...unknown} args - format arguments.
   * @returns {void}
   */
  const warn = (message, ...args) => {
    try {
      logger?.warn?.(message, ...args)
    } catch {
      // Diagnostics must never break the mode.
    }
  }

  const service = new HnflowService({ config: rawConfig, logger })
  /** @type {Map<string, string>} */
  const indexCache = new Map()

  /**
   * Effective working directory of an agent session.
   * @param {unknown} agent - agent handle.
   * @returns {string | null} absolute path, or null when unknown.
   */
  const cwdOf = (agent) => {
    const handle = /** @type {{session?: object} | undefined} */ (agent ?? undefined)
    if (handle?.session === undefined) return null
    const workingDirectory = ctx.get('workingDirectory')
    try {
      const cwd = workingDirectory?.get?.(handle.session)
      return typeof cwd === 'string' && cwd.length > 0 ? cwd : null
    } catch {
      return null
    }
  }

  /**
   * Refresh the cached workflow index for one workspace.
   * @param {string} cwd - workspace root.
   * @returns {Promise<void>} resolves after the cache update.
   */
  const refreshIndex = async (cwd) => {
    try {
      indexCache.set(cwd, await service.indexSection(cwd))
    } catch (error) {
      warn('hnflow: cannot build the workflow index: %o', error)
    }
  }

  ctx.inject(['tools'], (scope) => {
    void (async () => {
      try {
        const module = await loadHarnessModule(ctx, '@deepseek-ai/dsh-tools')
        const defineTool = module?.defineTool
        if (typeof defineTool !== 'function') {
          warn('hnflow: @deepseek-ai/dsh-tools does not export defineTool; the workflow tools stay unregistered')
          return
        }
        scope.tools.register(createWorkflowTool({ defineTool, service, cwdOf }))
        scope.tools.register(createWorkflowAuthorTool({ defineTool, service, cwdOf }))
      } catch (error) {
        warn('hnflow: cannot register the workflow tool: %o', error)
      }
    })()
  })

  ctx.inject(['commands'], (scope) => {
    try {
      scope.commands.register(createWorkflowCommand({ service, cwdOf }))
    } catch (error) {
      warn('hnflow: cannot register /workflow: %o', error)
    }
  })

  ctx.inject(['skills'], (scope) => {
    void (async () => {
      try {
        const skill = readSkillFile(await readFile(SKILL_FILE, 'utf8'))
        if (skill.name.length === 0 || skill.description.length === 0) {
          warn('hnflow: the bundled skill has no name/description frontmatter; skipping')
          return
        }
        scope.skills.register({ name: skill.name, description: skill.description, content: skill.content })
      } catch (error) {
        warn('hnflow: cannot load the bundled skill: %o', error)
      }
    })()
  })

  ctx.inject(['systemPrompt'], (scope) => {
    try {
      scope.systemPrompt.section({
        name: 'hnflow:workflows',
        order: SECTION_ORDER,
        text: (assembly) => {
          const cwd = cwdOf(assembly?.agent)
          if (cwd === null) return ''
          return indexCache.get(cwd) ?? ''
        },
      })
    } catch (error) {
      warn('hnflow: cannot register the workflow prompt section: %o', error)
    }
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (decision?.kind === 'reject' || payload?.signal?.aborted === true) return decision
      const cwd = cwdOf(payload?.agent)
      if (cwd !== null) await refreshIndex(cwd)
      return decision
    } catch (error) {
      warn('hnflow: pre-step failed: %o', error)
      return decision
    }
  })

  ctx.effect(() => () => {
    indexCache.clear()
    service.dispose()
    return undefined
  }, 'hnflow: stop the workflow engine and drop cached state')
}

/**
 * Import a harness package the way the Loader does, falling back to plain ESM.
 *
 * A linked bundle lives outside the harness `node_modules`, so a bare import may
 * not resolve through Node alone; the Loader's internal importer applies the
 * harness resolution rules, while the plain import keeps tests usable.
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

/** Exported for tests and for the usage hint in plugin documentation. */
export const COMMAND_USAGE = USAGE
