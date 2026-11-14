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
export const ACTIONS = Object.freeze([
  'list_flows',
  'list_library',
  'describe_flow',
  'run',
  'status',
  'list_runs',
  'cancel',
  'resume',
  'inbox',
  'artifact',
  'add_ref',
  'remove_ref',
  'rename_ref',
  'pin',
  'history',
  'triggers',
])

/**
 * Render a run summary.
 * @param {Record<string, any>} run - summary from `summariseRun`.
 * @returns {string} model-facing text.
 */
export function formatRun(run) {
  const revision = run.source === 'local' || run.revision === null ? 'project draft' : `r${run.revision}`
  const lines = [`run ${run.runId}: ${run.status} (${run.flowName ?? run.flowId} ${revision})`]
  if (run.error !== null && run.error !== undefined) lines.push(`error: ${run.error.code}: ${run.error.message}`)
  if (Array.isArray(run.nodes) && run.nodes.length > 0) {
    lines.push(`nodes: ${run.nodes.map((node) => `${node.id}=${node.status}${node.attempts > 1 ? `(x${node.attempts})` : ''}`).join(', ')}`)
    for (const node of run.nodes) {
      if (node.diagnostic !== null && node.diagnostic !== undefined) lines.push(`  ${node.id}: ${node.diagnostic.code} — ${node.diagnostic.message}`)
    }
  }
  if (run.pending > 0) lines.push(`waiting on ${run.pending} human item(s); see /hnflow inbox or the HNFlow page`)
  if (Array.isArray(run.degradations) && run.degradations.length > 0) {
    lines.push(`degraded: ${run.degradations.map((entry) => `${entry.nodeId}->${(entry.fallbackNodeIds ?? []).join('|')} (${entry.code})`).join(', ')}`)
  }
  if (run.usage !== null && run.usage !== undefined) {
    lines.push(`usage: ${run.usage.totalTokens} tokens (in ${run.usage.inputTokens} / out ${run.usage.outputTokens}, ${run.usage.calls} call(s))`)
  }
  if (Array.isArray(run.artifacts) && run.artifacts.length > 0) {
    lines.push(`artifacts: ${run.artifacts.map((artifact) => `${artifact.artifactId}${artifact.degraded ? ' [degraded]' : ''}`).join(', ')}`)
  }
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
      const name = entry.alias.length > 0 ? entry.alias : entry.local ? entry.name?.length > 0 ? entry.name : entry.flowId : entry.flowId
      const flags = [entry.local ? 'project-draft' : '', entry.missing ? 'missing' : '', entry.hasOverride ? 'draft-override' : '', entry.drift ? 'drift' : ''].filter((flag) => flag.length > 0)
      const revision = entry.local ? 'local, no revision' : entry.pinnedRevision === null ? `r${entry.currentRevision ?? '?'} (follows latest)` : `pinned r${entry.pinnedRevision} of r${entry.currentRevision ?? '?'}`
      return `- ${name} (${entry.flowId}, ${revision})${flags.length > 0 ? ` [${flags.join(', ')}]` : ''}${entry.description ? `: ${entry.description}` : ''}`
    })
    .join('\n')
}

/**
 * Render the reusable library.
 * @param {Record<string, any>[]} assets - library assets.
 * @returns {string} model-facing text.
 */
export function formatLibrary(assets) {
  if (assets.length === 0) return 'The reusable library has no flows.'
  return assets
    .map((asset) => `- ${asset.name} (${asset.id}, r${asset.revision ?? 1}${asset.folder ? `, folder ${asset.folder}` : ''})${asset.description ? `: ${asset.description}` : ''}`)
    .join('\n')
}

/**
 * Render one flow's revision history.
 * @param {Record<string, any>} history - service history result.
 * @returns {string} model-facing text.
 */
export function formatHistory(history) {
  const lines = [
    `flow ${history.alias || history.flowId} (${history.flowId})`,
    `source ${history.source}; current r${history.currentRevision}; reference ${history.pinnedRevision === null ? 'follows latest' : `pinned to r${history.pinnedRevision}`}`,
  ]
  for (const entry of history.revisions) {
    lines.push(`- r${entry.revision} ${entry.contentHash}${entry.snapshotAt ? ` @ ${entry.snapshotAt}` : ''}${entry.revision === history.currentRevision ? ' [current]' : ''}${entry.revision === history.pinnedRevision ? ' [pinned]' : ''}`)
  }
  return lines.join('\n')
}

/**
 * Parse a pin argument.
 * @param {unknown} value - `latest`, `r3`, `3`, or undefined.
 * @returns {'latest' | number} target.
 */
function parsePin(value) {
  if (value === undefined || value === null || value === '') return 'latest'
  const text = String(value).trim()
  if (text === 'latest' || text === 'null') return 'latest'
  const revision = Number(text.replace(/^r/u, ''))
  if (!Number.isInteger(revision) || revision < 1) {
    throw Object.assign(new Error(`revision must be "latest" or rN, got ${text}`), { code: 'revision-invalid' })
  }
  return revision
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
        case 'list_library':
          return formatLibrary(await service.listLibrary())
        case 'list_runs': {
          const runs = await service.listRuns()
          if (runs.length === 0) return 'No HNFlow runs yet.'
          return runs
            .slice(0, 20)
            .map((run) => {
              const summary = runSummary(run)
              const nodes = summary.nodes.map((node) => `${node.id}=${node.status}`).join(', ')
              return `${summary.runId} ${summary.status} ${summary.flowName ?? summary.flowId} (${summary.source}${summary.revision === null ? '' : ` r${summary.revision}`})${nodes.length > 0 ? ` — ${nodes}` : ''}`
            })
            .join('\n')
        }
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
          // Stage first: the owner needs to know what kind of act each item is,
          // and the list order is already "what to do first".
          return items
            .map((item, index) => `${index + 1}. [${item.stageLabel ?? item.kind}] ${item.summary ?? item.id} (id ${item.id}, run ${item.runId}${typeof item.expiresAt === 'string' ? `, expires ${item.expiresAt}` : ''})`)
            .join('\n')
        }
        case 'triggers': {
          return formatTriggers(await service.triggers())
        }
        case 'artifact': {
          const artifactId = requireArtifactId(args)
          const artifact = await service.getArtifact(artifactId)
          return JSON.stringify(artifact, null, 2)
        }
        case 'add_ref': {
          if (cwd === null) return 'error workspace-unavailable: this session has no workspace directory'
          const key = requireKey(args)
          const added = await service.addRef(cwd, key, typeof args.alias === 'string' ? args.alias : '')
          return `referenced ${added.name || added.flowId} as ${added.alias || added.flowId} (follows latest)`
        }
        case 'remove_ref': {
          if (cwd === null) return 'error workspace-unavailable: this session has no workspace directory'
          const removed = await service.removeRef({ cwd, key: requireKey(args) })
          return `removed the reference ${removed.alias || removed.flowId}${removed.hadOverride ? ' (its workspace draft remains on disk but is no longer listed)' : ''}`
        }
        case 'rename_ref': {
          if (cwd === null) return 'error workspace-unavailable: this session has no workspace directory'
          const alias = typeof args.alias === 'string' ? args.alias.trim() : ''
          if (alias.length === 0) return 'error alias-required: pass the new alias'
          const renamed = await service.renameRef({ cwd, key: requireKey(args), alias })
          return `reference renamed to ${renamed.alias}`
        }
        case 'pin': {
          if (cwd === null) return 'error workspace-unavailable: this session has no workspace directory'
          const target = parsePin(args.revision)
          const pinned = await service.pinRef(cwd, requireKey(args), target)
          return `${pinned.alias || pinned.flowId} now ${pinned.revision === null ? 'follows latest' : `is pinned to r${pinned.revision}`}`
        }
        case 'history': {
          if (cwd === null) return 'error workspace-unavailable: this session has no workspace directory'
          return formatHistory(await service.history(cwd, requireKey(args)))
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
      'Operate HNFlow flows. `list_flows` lists this workspace\'s referenced and project-local flows, `list_library` lists reusable assets, `describe_flow` returns one definition, `run` starts one and returns immediately (never wait for it), `status`/`list_runs`/`inbox` answer later questions, `cancel`/`resume` control a run, `artifact` returns a node output, and `add_ref`/`remove_ref`/`rename_ref`/`pin`/`history` manage the workspace reference. Publishing and deciding human gates/deliveries are human-only and are not available here.',
    parameters: {
      action: { type: 'string', required: true, enum: ACTIONS, description: 'Operation to perform.' },
      flow: { type: 'string', description: 'Flow alias, name, or id; used by describe_flow, run, history, add_ref, remove_ref, rename_ref and pin.' },
      run_id: { type: 'string', description: 'Run id; required by status, cancel and resume.' },
      artifact_id: { type: 'string', description: 'Artifact id from status; required by artifact.' },
      input: { type: 'object', additionalProperties: true, description: 'Start input matching the flow input schema (run only).' },
      alias: { type: 'string', description: 'Reference alias for add_ref / rename_ref.' },
      revision: { type: 'string', description: 'Pin target for pin: "latest" or "r3".' },
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
    nodes: Object.entries(run.nodes ?? {}).map(([id, state]) => ({ id, status: state.status, attempts: state.attempts, diagnostic: state.diagnostic, usage: state.usage ?? null, artifactId: state.artifactId ?? null })),
    pending: (run.pending ?? []).filter((entry) => entry.decision === undefined && entry.delivery === undefined).length,
    usage: run.usage ?? null,
    degradations: Array.isArray(run.degradations) ? run.degradations : [],
    artifacts: Object.values(run.artifacts ?? {}).map((entry) => ({ artifactId: entry.artifactId, nodeId: entry.nodeId, kind: entry.kind, degraded: entry.degraded === true })),
  }
}

/**
 * Render the trigger listing for the tool.
 * @param {{triggers: Record<string, any>[], errors?: Record<string, any>[], enabled: boolean}} listing - trigger listing.
 * @returns {string} text.
 */
function formatTriggers(listing) {
  const lines = [`automation: ${listing.enabled === false ? 'disabled' : 'enabled'}`]
  if ((listing.triggers ?? []).length === 0) lines.push('no triggers in .hnflow/triggers.json')
  for (const trigger of listing.triggers ?? []) {
    const when = trigger.source === 'cron' ? trigger.cron : trigger.source === 'file' ? (trigger.watch ?? []).join(', ') : `after ${trigger.after}`
    lines.push(`- ${trigger.id} [${trigger.source}] ${when} → ${trigger.flow}${trigger.enabled === false ? ' (disabled)' : ''}${typeof trigger.lastFiredAt === 'string' ? `; last fired ${trigger.lastFiredAt}` : ''}`)
  }
  for (const error of listing.errors ?? []) lines.push(`- invalid ${error.id}: ${error.error}`)
  return lines.join('\n')
}

/**
 * Require the artifact id argument.
 * @param {Record<string, any>} args - tool arguments.
 * @returns {string} artifact id.
 */
function requireArtifactId(args) {
  const artifactId = typeof args.artifact_id === 'string' ? args.artifact_id.trim() : ''
  if (artifactId.length === 0) throw Object.assign(new Error('artifact_id is required: pass one from action "status"'), { code: 'artifact-id-required' })
  return artifactId
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
