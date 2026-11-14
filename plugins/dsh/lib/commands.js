/**
 * `/hnflow`: the human command surface.
 *
 * Flows are capability-group content: listing and inspecting only. Creating and
 * editing belong to `hnflow_author`; gate decisions and deliveries belong to the
 * inbox. No publish, revision or library verb exists.
 */

import { summariseRun } from './service.js'

/** Command name. */
export const COMMAND_NAME = 'hnflow'

/** Usage text returned for an unknown subcommand. */
export const USAGE = [
  'HNFlow 用法：',
  '  /hnflow list                   列出本工作区激活能力组中的流程',
  '  /hnflow runs                   最近运行',
  '  /hnflow status <runId>         一次运行的节点状态',
  '  /hnflow inbox                  待处理的门禁与交付',
  '  /hnflow open                   打开左侧 HNFlow 页面',
].join('\n')

/**
 * Build the `/hnflow` command definition.
 * @param {{
 *   service: Record<string, any>,
 *   cwdOf: (agent: unknown) => string | null,
 *   config: Record<string, any>,
 *   logger?: Record<string, any>,
 * }} options - wiring.
 * @returns {Record<string, any>} command definition.
 */
export function createFlowCommand(options) {
  const { service, cwdOf, logger } = options

  /**
   * Run one subcommand.
   * @param {Record<string, any>} invocation - command invocation.
   * @returns {Promise<{kind: 'success'|'error', text: string}>} result.
   */
  const handler = async (invocation) => {
    const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : ''
    const [verb, ...rest] = raw.split(/\s+/u).filter((part) => part.length > 0)
    const cwd = cwdOf(invocation?.agent)
    if (verb === undefined || verb === 'help') return { kind: 'success', text: USAGE }
    if (cwd === null && !['inbox', 'runs', 'status', 'open', 'help'].includes(verb ?? '')) {
      return { kind: 'error', text: '这个会话没有工作区目录。' }
    }
    try {
      switch (verb) {
        case 'list': {
          const entries = await service.listFlows(cwd)
          if (entries.length === 0) return { kind: 'success', text: '本工作区的激活能力组里还没有流程。' }
          return {
            kind: 'success',
            text: entries
              .map((entry) => {
                const owner = entry.module ? `${entry.group}/${entry.module}` : entry.group
                return `- ${entry.name || entry.flowId}（${entry.flowId}，能力组 ${owner}）${entry.description ? `：${entry.description}` : ''}`
              })
              .join('\n'),
          }
        }
        case 'runs': {
          const runs = await service.listRuns()
          if (runs.length === 0) return { kind: 'success', text: '还没有运行记录。' }
          return {
            kind: 'success',
            text: runs
              .slice(0, 20)
              .map((run) => {
                const summary = summariseRun(run)
                const nodes = summary.nodes.map((node) => `${node.id}=${node.status}`).join(', ')
                return `${summary.runId} ${summary.status} ${summary.flowName ?? summary.flowId}${nodes.length > 0 ? ` — ${nodes}` : ''}`
              })
              .join('\n'),
          }
        }
        case 'status': {
          const runId = rest[0]
          if (runId === undefined) return { kind: 'error', text: '用法：/hnflow status <runId>' }
          const run = summariseRun(await service.getRun(runId))
          const lines = [`${run.runId}: ${run.status} (${run.flowName ?? run.flowId})`]
          for (const node of run.nodes) {
            lines.push(`- ${node.id}: ${node.status}${node.attempts > 1 ? ` ×${node.attempts}` : ''}${node.diagnostic ? ` — ${node.diagnostic.code}: ${node.diagnostic.message}` : ''}`)
          }
          if (run.pending > 0) lines.push(`待人工处理 ${run.pending} 项：/hnflow inbox`)
          return { kind: 'success', text: lines.join('\n') }
        }
        case 'inbox': {
          const items = await service.inbox()
          if (items.length === 0) return { kind: 'success', text: '收件箱是空的。' }
          return {
            kind: 'success',
            text: items
              .map((item) => `- ${item.id}（${item.kind === 'gate' ? '门禁' : '交付'}，run ${item.runId}，节点 ${item.nodeId}）${item.whyHuman ? `：${item.whyHuman}` : ''}`)
              .join('\n'),
          }
        }
        case 'open':
          return { kind: 'success', text: '从左侧栏的 HNFlow 图标打开页面；收件箱在第三页签。' }
        default:
          return { kind: 'error', text: `未知子命令：${verb}\n\n${USAGE}` }
      }
    } catch (error) {
      logger?.warn?.('hnflow: /hnflow %s failed: %o', verb, error)
      return { kind: 'error', text: `${error?.code ?? 'internal'}: ${error?.message ?? String(error)}` }
    }
  }

  return {
    name: COMMAND_NAME,
    description: '列出、查看和打开 HNFlow 流程与运行',
    arguments: [{ name: 'subcommand', description: 'list | runs | status <runId> | inbox | open', required: false }],
    handler,
  }
}
