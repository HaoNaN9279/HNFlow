/**
 * The `hnflow` tool: a thin model-facing surface over the orchestrator.
 *
 * It can list, describe, start, inspect and cancel — never publish, never
 * decide a gate, never accept a delivery. Those are human actions. `run`
 * returns as soon as the run exists: a run outlives the turn, and its progress
 * belongs to the HNFlow page, not to a polling loop in the conversation.
 */

import { defineTool } from './tool-schema.js'

/** Actions the tool accepts. */
export const ACTIONS = Object.freeze(['list_flows', 'describe_flow', 'run', 'status', 'cancel', 'resume', 'inbox'])

/**
 * Render a run summary.
 * @param {Record<string, any>} run - summary from `summariseRun`.
 * @returns {string} model-facing text.
 */
export function formatRun(run) {
  const lines = [`run ${run.runId}: ${run.status} (${run.flowName ?? run.flowId} r${run.revision ?? 'latest'})`]
  if (run.error !== null && run.error !== undefined) lines.push(`error: ${run.error.code}: ${run.error.message}`)
  if (Array.isArray(run.nodes) && run.nodes.length > 0) {
    lines.push(`nodes: ${run.nodes.map((node) => `${node.id}=${node.status}${node.attempts > 1 ? `(x${node.attempts})` : ''}`).join(', ')}`)
    for (const node of run.nodes) {
      if (node.diagnostic !== null && node.diagnostic !== undefined) lines.push(`  ${node.id}: ${node.diagnostic.code} — ${node.diagnostic.message}`)
    }
  }
  if (run.pending > 0) lines.push(`waiting on ${run.pending} human item(s); see /hnflow inbox or the HNFlow page`)
  return lines.join('\n')
}

/**
 * Render the workspace catalogue.
 * @param {Record<string, any>[]} entries - catalogue.
 * @returns {string} model-facing text.
 */
export function formatFlows(entries) {
  if (entries.length === 0) return 'This workspace references no HNFlow flows.'
  return entries
    .map((entry) => {
      const name = entry.alias.length > 0 ? entry.alias : entry.flowId
      const flags = [entry.missing ? 'missing' : '', entry.hasOverride ? 'draft-override' : '', entry.drift ? 'drift' : ''].filter((flag) => flag.length > 0)
      const revision = entry.pinnedRevision === null ? `r${entry.currentRevision ?? '?'} (follows latest)` : `pinned r${entry.pinnedRevision} of r${entry.currentRevision ?? '?'}`
      return `- ${name} (${entry.flowId}, ${revision})${flags.length > 0 ? ` [${flags.join(', ')}]` : ''}${entry.description ? `: ${entry.description}` : ''}`
    })
    .join('\n')
}

/**
 * Build the `hnflow` tool definition.
 * @param {{service: Record<string, any>, cwdOf: (agent: unknown) => string | null}} options - wiring.
 * @returns {Record<string, any>} tool definition.
 */
export function createFlowTool(options) {
  const { service, cwdOf } = options

  /**
   * Dispatch one action.
   * @param {Record<string, any>} args - validated arguments.
   * @param {{agent?: unknown}} exec - execution context.
   * @returns {Promise<string>} model-facing text.
   */
  const execute = async (args, exec) => {
    const cwd = cwdOf(exec?.agent)
    try {
      switch (args.action) {
        case 'list_flows':
          if (cwd === null) return 'error workspace-unavailable: this session has no workspace directory'
          return formatFlows(await service.listFlows(cwd))
        case 'describe_flow': {
          if (cwd === null) return 'error workspace-unavailable: this session has no workspace directory'
          const key = requireKey(args)
          const resolved = await service.describeFlow(cwd, key)
          return [
            `flow ${resolved.alias || resolved.flowId} (${resolved.flowId})`,
            `source: ${resolved.source}; revision ${resolved.revision ?? 'latest'} of ${resolved.currentRevision}; drift: ${resolved.drift}`,
            `definition: ${JSON.stringify(resolved.definition)}`,
          ].join('\n')
        }
        case 'run': {
          if (cwd === null) return 'error workspace-unavailable: this session has no workspace directory'
          const key = requireKey(args)
          const sessionId = typeof exec?.agent?.session?.id === 'string' ? exec.agent.session.id : undefined
          const started = await service.run({ cwd, key, input: args.input ?? {}, hostSessionId: sessionId })
          return [
            `started ${started.runId} (${key}); it continues without this turn.`,
            'Report this run id and stop: do not poll, wait, or simulate its nodes. Human work appears in /hnflow inbox and on the HNFlow page.',
          ].join('\n')
        }
        case 'status': {
          const run = await service.getRun(requireRunId(args))
          return formatRun(runSummary(run))
        }
        case 'cancel': {
          const result = await service.cancel(requireRunId(args))
          return `cancelled ${result.runId} (status ${result.status})`
        }
        case 'resume': {
          const result = await service.resume(requireRunId(args))
          return `resumed ${result.runId}; unfinished nodes continue without this turn.`
        }
        case 'inbox': {
          const items = await service.inbox()
          if (items.length === 0) return 'The HNFlow inbox is empty.'
          return items
            .map((item) => `- ${item.id} (${item.kind}, run ${item.runId}, node ${item.nodeId})${item.whyHuman ? `: ${item.whyHuman}` : ''}`)
            .join('\n')
        }
        default:
          return `error invalid-action: expected one of ${ACTIONS.join(', ')}`
      }
    } catch (error) {
      return `error ${error?.code ?? 'internal'}: ${error?.message ?? String(error)}`
    }
  }

  return defineTool({
    name: 'hnflow',
    description:
      'Operate the workspace\'s HNFlow flows. `list_flows` lists them, `describe_flow` returns one definition, `run` starts one and returns immediately (never wait for it), `status`/`inbox` answer a later question, `cancel`/`resume` control a run. Publishing and deciding human gates/deliveries are human-only actions and are not available here.',
    parameters: {
      action: { type: 'string', required: true, enum: ACTIONS, description: 'Operation to perform.' },
      flow: { type: 'string', description: 'Flow alias or id; required by describe_flow and run.' },
      run_id: { type: 'string', description: 'Run id; required by status, cancel and resume.' },
      input: { type: 'object', additionalProperties: true, description: 'Start input matching the flow input schema (run only).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute,
  })
}

/**
 * Compact run summary for the tool.
 * @param {Record<string, any>} run - run record.
 * @returns {Record<string, any>} summary.
 */
function runSummary(run) {
  return {
    runId: run.runId,
    flowId: run.flowId,
    flowName: run.flowName,
    revision: run.revision,
    status: run.status,
    error: run.error,
    nodes: Object.entries(run.nodes ?? {}).map(([id, state]) => ({ id, status: state.status, attempts: state.attempts, diagnostic: state.diagnostic })),
    pending: (run.pending ?? []).filter((entry) => entry.decision === undefined && entry.delivery === undefined).length,
  }
}

/**
 * Require the flow argument.
 * @param {Record<string, any>} args - tool arguments.
 * @returns {string} key.
 */
function requireKey(args) {
  const key = typeof args.flow === 'string' ? args.flow.trim() : ''
  if (key.length === 0) {
    throw Object.assign(new Error('flow is required: pass the alias or id from action "list_flows"'), { code: 'flow-required' })
  }
  return key
}

/**
 * Require the run id argument.
 * @param {Record<string, any>} args - tool arguments.
 * @returns {string} run id.
 */
function requireRunId(args) {
  const runId = typeof args.run_id === 'string' ? args.run_id.trim() : ''
  if (runId.length === 0) throw Object.assign(new Error('run_id is required'), { code: 'run-id-required' })
  return runId
}
