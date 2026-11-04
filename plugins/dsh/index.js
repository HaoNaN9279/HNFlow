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

import { USAGE, createViewerCommand, createWorkflowCommand } from './lib/commands.js'
import { createWorkflowAuthorTool } from './lib/author.js'
import { questionsForTask } from './lib/questions.js'
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

  const service = new HnflowService({ config: rawConfig, logger, llm: llmAdapter(ctx) })
  // The root row exists only so the client half is always available; it owns no
  // host behaviour and must not touch any session.
  if (service.config.host === false) return
  // The resident viewer row: page data for every session, no tools, no engine.
  if (service.config.role === 'viewer') {
    ctx.inject(['commands'], (scope) => {
      try {
        scope.commands.register(createViewerCommand({ service }))
      } catch (error) {
        warn('hnflow: cannot register /hnflow: %o', error)
      }
    })
    ctx.effect(() => () => {
      service.dispose()
      return undefined
    }, 'hnflow: stop the viewer row')
    return
  }
  /** @type {Map<string, string>} */
  const indexCache = new Map()

  // Resume what a previous process left half-done: an engine restart marks its
  // runs `interrupted` even though the checkpoints are intact. Deferred so the
  // session list is already usable when the engine starts.
  if (service.config.autoResume) {
    const timer = setTimeout(() => {
      void service
        .resumeInterrupted()
        .then((outcome) => {
          if (outcome.resumed.length > 0) warn('hnflow: resumed %d interrupted run(s)', outcome.resumed.length)
          for (const failure of outcome.failed) warn('hnflow: cannot resume %s: %s', failure.runId, failure.message)
        })
        .catch((error) => warn('hnflow: auto-resume failed: %o', error))
    }, 4000)
    ctx.effect(() => () => {
      clearTimeout(timer)
      return undefined
    }, 'hnflow: auto-resume timer')
  }

  /**
   * Ask the user about one waiting human task and build its submission payload.
   *
   * Returns null whenever the question path is unavailable (no service, no live
   * agent, nothing chosen); the caller then leaves the task pending rather than
   * submitting a guess.
   * @param {Record<string, any>} task - pending task summary.
   * @param {{agent?: unknown, signal?: AbortSignal}} exec - tool execution context.
   * @returns {Promise<Record<string, any> | null>} payload or null.
   */
  const askTask = async (task, exec) => {
    const userQuestions = ctx.get('userQuestions')
    if (typeof userQuestions?.ask !== 'function' || exec?.agent === undefined) return null
    const { questions, build } = questionsForTask(task)
    if (questions.length === 0) return null
    const answer = await userQuestions.ask({ questions, agent: exec.agent, signal: exec.signal })
    return build(answer)
  }

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
        scope.tools.register(createWorkflowTool({ defineTool, service, cwdOf, askTask }))
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
 * Adapt the harness LLM service to the engine's completion request.
 *
 * Stage 2 of the model bridge: an AI node configured with
 * `use: deerflow.workflow.rpc.llm_bridge:BridgeChatModel` sends its messages
 * here, and this runs them on DSH's own provider route and credentials and
 * returns the assembled text.
 * @param {Record<string, any>} ctx - plugin context.
 * @returns {{complete: (payload: Record<string, any>) => Promise<{text: string}>}} adapter.
 */
export function llmAdapter(ctx) {
  return {
    complete: async (payload) => {
      const llm = ctx.get('llm')
      if (typeof llm?.stream !== 'function') {
        throw Object.assign(new Error('this session has no DSH LLM service to complete with'), { code: 'llm-unavailable' })
      }
      const messages = (Array.isArray(payload?.messages) ? payload.messages : []).map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user',
        content: [{ type: 'text', text: String(message.text ?? '') }],
      }))
      /** @type {Record<string, any>} */
      const request = { model: String(payload?.model ?? ''), messages }
      if (typeof payload?.provider === 'string' && payload.provider.length > 0) request.provider = payload.provider
      let text = ''
      for await (const chunk of llm.stream(request)) {
        if (typeof chunk?.text === 'string') text += chunk.text
        else if (typeof chunk?.delta === 'string') text += chunk.delta
        if (chunk?.kind === 'finish' && chunk.failure) {
          const failure = chunk.failure
          throw Object.assign(new Error(String(failure.message ?? 'the model call failed')), { code: String(failure.code ?? 'llm-error') })
        }
      }
      return { text }
    },
  }
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
