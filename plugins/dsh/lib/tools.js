/**
 * The `workflow` tool: run and observe, with an explicit workflow name.
 *
 * The model must pass `workflow` for anything that addresses one definition; the
 * tool never guesses between candidates. Errors come back as ordinary tool text
 * with a stable code, so a failed call does not end the turn.
 */

/** Actions the tool accepts. */
export const WORKFLOW_ACTIONS = ['list', 'get', 'run', 'status', 'cancel', 'resume', 'events', 'assets', 'task_list', 'task_submit']

/** Default wait budget for `run`, in seconds. */
export const DEFAULT_RUN_WAIT_SECONDS = 30
/** Hard cap for the wait budget. */
export const MAX_RUN_WAIT_SECONDS = 300

/**
 * Render a run record as compact text.
 * @param {Record<string, any>} status - engine run record.
 * @returns {string} model-facing summary.
 */
export function formatRunStatus(status) {
  const lines = [`run ${status.runId}: ${status.status}`]
  if (typeof status.error === 'string' && status.error.length > 0) lines.push(`error: ${status.error}`)
  if (Array.isArray(status.nodes) && status.nodes.length > 0) {
    lines.push(`nodes: ${status.nodes.map((node) => `${node.nodeId}=${node.status}`).join(', ')}`)
  }
  if (status.result !== null && status.result !== undefined) lines.push(`result: ${JSON.stringify(status.result)}`)
  const tasks = Array.isArray(status.pendingTasks) ? status.pendingTasks : []
  for (const task of tasks) lines.push(`waiting on task ${task.taskId} (${task.kind} node ${task.nodeId}): ${task.description}`)
  return lines.join('\n')
}

/**
 * Render a pending-task list.
 * @param {Record<string, any>[]} tasks - task summaries.
 * @returns {string} model-facing summary.
 */
export function formatTasks(tasks) {
  if (tasks.length === 0) return 'No pending human tasks.'
  return tasks
    .map((task) => {
      const fields = (task.outputSpec?.ports ?? []).map((port) => `${port.name}:${port.type}${port.required ? '!' : ''}`).join(', ')
      return `- ${task.taskId} (run ${task.runId}, node ${task.nodeId}, ${task.kind})${fields.length > 0 ? ` fields: ${fields}` : ''}${task.description ? ` — ${task.description}` : ''}`
    })
    .join('\n')
}

/**
 * Render a workflow index as a table-ish list.
 * @param {Record<string, any>[]} entries - catalogue entries.
 * @returns {string} model-facing summary.
 */
export function formatWorkflowList(entries) {
  if (entries.length === 0) return 'This workspace references no HNFlow workflows.'
  return entries
    .map((entry) => {
      const name = entry.alias.length > 0 ? entry.alias : entry.assetId
      const flags = [entry.missing ? 'missing-asset' : '', entry.hasOverride ? 'override' : '', entry.drift ? 'drift' : ''].filter((flag) => flag.length > 0)
      const revision = entry.pinnedRevision === null ? `r${entry.currentRevision ?? '?'}` : `pinned r${entry.pinnedRevision} of r${entry.currentRevision ?? '?'}`
      return `- ${name} (${entry.assetId}, ${revision})${flags.length > 0 ? ` [${flags.join(', ')}]` : ''}${entry.description ? `: ${entry.description}` : ''}`
    })
    .join('\n')
}

/**
 * Render a run's event log as a timeline.
 * @param {{events?: Record<string, any>[]}} log - `run/events` result.
 * @returns {string} model-facing summary.
 */
export function formatTimeline(log) {
  const events = Array.isArray(log?.events) ? log.events : []
  if (events.length === 0) return 'no events recorded for this run'
  return events
    .map((event) => {
      const node = typeof event.nodeId === 'string' && event.nodeId.length > 0 ? ` ${event.nodeId}` : ''
      const detail = event.data && typeof event.data === 'object' ? summarise(event.data) : ''
      return `${String(event.seq).padStart(3, ' ')}  ${String(event.at ?? '').slice(11, 23)}  ${event.type}${node}${detail.length > 0 ? `  ${detail}` : ''}`
    })
    .join('\n')
}

/**
 * One compact detail string for an event payload.
 * @param {Record<string, any>} data - event data.
 * @returns {string} detail, or an empty string.
 */
function summarise(data) {
  if (typeof data.error === 'string' && data.error.length > 0) return data.error.slice(0, 120)
  if (data.output !== undefined) return JSON.stringify(data.output).slice(0, 120)
  if (typeof data.status === 'string') return data.status
  return ''
}

/**
 * Build the `workflow` tool definition.
 * @param {{
 *   defineTool: Function,
 *   service: import('./service.js').HnflowService,
 *   cwdOf: (agent: unknown) => string | null,
 * }} options - wiring.
 * @returns {Record<string, any>} the tool definition handed to `ctx.tools.register`.
 */
export function createWorkflowTool(options) {
  const { defineTool, service, cwdOf, askTask = null } = options

  /**
   * Answer waiting human tasks with question cards while the caller allows it.
   *
   * Bounded to three rounds so a workflow that keeps asking cannot hold the tool
   * open indefinitely; every round still ends in a real submit + wait.
   * @param {Record<string, any>} status - run status.
   * @param {{agent?: unknown, signal?: AbortSignal}} exec - execution context.
   * @param {boolean} interactive - whether the caller wants cards.
   * @returns {Promise<Record<string, any>>} the latest status.
   */
  const settle = async (status, exec, interactive) => {
    let current = status
    for (let round = 0; round < 3; round += 1) {
      if (current.status !== 'waiting_human') return current
      const tasks = Array.isArray(current.pendingTasks) ? current.pendingTasks : []
      if (!interactive || askTask === null || tasks.length !== 1) return current
      let payload
      try {
        payload = await askTask(tasks[0], exec)
      } catch {
        return current
      }
      if (payload === null || payload === undefined) return current
      await service.submitTask({ taskId: tasks[0].taskId, payload })
      current = await service.waitFor(current.runId, 60000)
    }
    return current
  }

  /**
   * Run one action.
   * @param {Record<string, any>} args - validated arguments.
   * @param {{agent?: unknown, signal?: AbortSignal}} exec - execution context.
   * @returns {Promise<string>} model-facing text.
   */
  const execute = async (args, exec) => {
    const cwd = cwdOf(exec?.agent)
    try {
      if (cwd === null) return 'error workspace-unavailable: this session has no workspace directory'
      return await run(args, cwd, exec)
    } catch (error) {
      return `error ${error?.code ?? 'internal'}: ${error?.message ?? String(error)}`
    }
  }

  /**
   * Dispatch one action against a resolved workspace.
   * @param {Record<string, any>} args - validated arguments.
   * @param {string} cwd - workspace root.
   * @param {{agent?: unknown, signal?: AbortSignal}} exec - execution context.
   * @returns {Promise<string>} model-facing text.
   */
  const run = async (args, cwd, exec) => {
    const interactive = args.interactive !== false
    switch (args.action) {
      case 'list':
        return formatWorkflowList(await service.listWorkflows(cwd))
      case 'assets': {
        const assets = await service.listAssets(cwd)
        if (assets.length === 0) return 'The HNFlow library has no workflow assets yet.'
        return assets.map((asset) => `- ${asset.name} (${asset.id}, r${asset.revision})${asset.description ? `: ${asset.description}` : ''}`).join('\n')
      }
      case 'get': {
        const resolved = await service.resolve(cwd, requireWorkflow(args))
        return [
          `workflow ${resolved.alias || resolved.assetId} (${resolved.assetId})`,
          `source: ${resolved.source}; revision: ${resolved.revision ?? 'latest'} of ${resolved.currentRevision}; drift: ${resolved.drift}`,
          `definition: ${JSON.stringify(resolved.definition)}`,
        ].join('\n')
      }
      case 'run': {
        const key = requireWorkflow(args)
        // The tool runs inside a session, so it can name it without a flag.
        const sessionId = typeof exec?.agent?.session?.id === 'string' ? exec.agent.session.id : null
        const started = await service.startRun({ cwd, key, inputs: args.input ?? {}, sessionId })
        const waitSeconds = clampWait(args.wait_seconds)
        const observed = waitSeconds > 0 ? await service.waitFor(started.runId, waitSeconds * 1000) : await service.status(started.runId)
        const status = await settle(observed, exec, interactive)
        const header = `started ${started.runId} from ${started.resolved.source} r${started.resolved.revision ?? 'latest'}`
        return `${header}\n${formatRunStatus(status)}`
      }
      case 'status':
        return formatRunStatus(await service.status(requireRunId(args)))
      case 'cancel':
        return JSON.stringify(await service.cancel(requireRunId(args)))
      case 'resume': {
        const resumed = await service.resume(requireRunId(args))
        const status = await service.waitFor(resumed.runId, clampWait(args.wait_seconds) * 1000)
        return `resumed ${resumed.runId}\n${formatRunStatus(status)}`
      }
      case 'events':
        return formatTimeline(await service.events(requireRunId(args), 0))
      case 'task_list':
        return formatTasks((await service.tasks(requireRunId(args))).tasks)
      case 'task_submit': {
        const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''
        if (taskId.length === 0) return 'error task-id-required: pass task_id from action "task_list"'
        const submitted = await service.submitTask({ taskId, payload: args.input ?? {}, revision: Number.isInteger(args.revision) ? args.revision : undefined })
        const status = await settle(await service.waitFor(submitted.runId, 60000), exec, interactive)
        return `submitted ${taskId}\n${formatRunStatus(status)}`
      }
      default:
        return `error invalid-action: expected one of ${WORKFLOW_ACTIONS.join(', ')}`
    }
  }

  return defineTool({
    name: 'hnflow',
    description:
      'Run and inspect HNFlow workflows referenced by this workspace. Every action that addresses one workflow must pass its name (alias or asset id) from `list`; the tool never guesses. `run` accepts an `input` object matching the start node ports and waits for completion or for a human task. `task_list`/`task_submit` handle the human steps of a suspended run.',
    parameters: {
      action: { type: 'string', required: true, enum: WORKFLOW_ACTIONS, description: 'Operation to perform.' },
      workflow: { type: 'string', description: 'Workflow alias or asset id; required by get and run.' },
      run_id: { type: 'string', description: 'Run id returned by run; required by status, cancel, resume, events, and task_list.' },
      input: { type: 'object', additionalProperties: true, description: 'Start-node port values for run, or the task fields for task_submit.' },
      task_id: { type: 'string', description: 'Human task id from task_list; required by task_submit.' },
      revision: { type: 'number', description: 'Task revision from task_list; rejects a stale submission when passed.' },
      interactive: { type: 'boolean', description: 'Ask question cards for a waiting human task (default true); pass false to leave it pending.' },
      wait_seconds: { type: 'number', description: `How long run waits for completion (default ${DEFAULT_RUN_WAIT_SECONDS}, max ${MAX_RUN_WAIT_SECONDS}).` },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute,
  })
}

/**
 * Clamp the caller's wait budget.
 * @param {unknown} value - requested seconds.
 * @returns {number} seconds to wait.
 */
export function clampWait(value) {
  if (value === undefined || value === null) return DEFAULT_RUN_WAIT_SECONDS
  if (!Number.isFinite(value)) return DEFAULT_RUN_WAIT_SECONDS
  return Math.max(0, Math.min(MAX_RUN_WAIT_SECONDS, Number(value)))
}

/**
 * Require the workflow argument.
 * @param {Record<string, any>} args - tool arguments.
 * @returns {string} the workflow key.
 */
function requireWorkflow(args) {
  const key = typeof args.workflow === 'string' ? args.workflow.trim() : ''
  if (key.length === 0) {
    /** @type {Error & {code?: string}} */
    const error = new Error('workflow is required: pass the alias or asset id from action "list"')
    error.code = 'workflow-required'
    throw error
  }
  return key
}

/**
 * Require the run id argument.
 * @param {Record<string, any>} args - tool arguments.
 * @returns {string} the run id.
 */
function requireRunId(args) {
  const runId = typeof args.run_id === 'string' ? args.run_id.trim() : ''
  if (runId.length === 0) {
    /** @type {Error & {code?: string}} */
    const error = new Error('run_id is required')
    error.code = 'run-id-required'
    throw error
  }
  return runId
}
