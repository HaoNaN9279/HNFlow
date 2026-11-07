/**
 * `/hnflow`: the human command surface.
 *
 * Commands never enter the model context (the adapter renders their result in
 * the UI). Publishing lives here — with a preview followed by an explicit
 * `confirm` — because only a person may advance a revision.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { AssetStore } from './assets.js'
import { createStores } from './resolve.js'
import { libraryRoot } from './paths.js'
import { summariseRun } from './service.js'
import { convertDefinition, formatImportReport } from './import.js'

/** Command name. */
export const COMMAND_NAME = 'hnflow'

/** Usage text returned for an unknown subcommand. */
export const USAGE = [
  'HNFlow 用法：',
  '  /hnflow list                   列出本工作区引用的流程',
  '  /hnflow runs                   最近运行',
  '  /hnflow status <runId>         一次运行的节点状态',
  '  /hnflow inbox                  待处理的门禁与交付',
  '  /hnflow publish <流程>         预览发布（校验 + 变更 diff + 版本信息）',
  '  /hnflow publish <流程> confirm 确认发布为新的不可变 revision',
  '  /hnflow history <流程>         版本历史',
  '  /hnflow rollback <流程> rN     预览回滚（以旧版本为新 revision）',
  '  /hnflow rollback <流程> rN confirm 确认回滚',
  '  /hnflow pin <流程> <latest|rN> 改引用钉住的版本',
  '  /hnflow assets                 列出通用资产库里的流程',
  '  /hnflow add <流程id> [别名]     把通用资产引用到本工作区',
  '  /hnflow promote <流程> [目录]   把项目草稿提升为通用资产并改为引用',
  '  /hnflow import <名称> <文件>    导入流程（兼容旧 WorkflowDefinition，转换结果先报告再落库）',
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
  const { service, cwdOf, config, logger } = options

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
    if (cwd === null && !['inbox', 'runs', 'status', 'assets', 'open', 'help'].includes(verb ?? '')) {
      return { kind: 'error', text: '这个会话没有工作区目录。' }
    }
    try {
      switch (verb) {
        case 'list': {
          const entries = await service.listFlows(cwd)
          if (entries.length === 0) return { kind: 'success', text: '本工作区还没有引用任何 HNFlow 流程。' }
          return {
            kind: 'success',
            text: entries
              .map((entry) => {
                const name = entry.alias.length > 0 ? entry.alias : entry.local ? entry.name?.length > 0 ? entry.name : entry.flowId : entry.flowId
                const flags = [entry.local ? '项目草稿' : '', entry.missing ? '缺失' : '', entry.hasOverride ? '草稿覆盖' : '', entry.drift ? '漂移' : ''].filter((flag) => flag.length > 0)
                const revision = entry.local ? '本地，无版本' : entry.pinnedRevision === null ? `r${entry.currentRevision ?? '?'}（跟随最新）` : `钉住 r${entry.pinnedRevision}/${entry.currentRevision ?? '?'}`
                return `- ${name} (${entry.flowId}, ${revision})${flags.length > 0 ? ` [${flags.join(', ')}]` : ''}${entry.description ? `：${entry.description}` : ''}`
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
                return `${summary.runId} ${summary.status} ${summary.flowName ?? summary.flowId} ${summary.source === 'local' ? '项目草稿' : `r${summary.revision ?? 'latest'}`}${nodes.length > 0 ? ` — ${nodes}` : ''}`
              })
              .join('\n'),
          }
        }
        case 'status': {
          const runId = rest[0]
          if (runId === undefined) return { kind: 'error', text: '用法：/hnflow status <runId>' }
          const run = summariseRun(await service.getRun(runId))
          const lines = [`${run.runId}: ${run.status} (${run.flowName ?? run.flowId} ${run.source === 'local' ? '项目草稿' : `r${run.revision ?? 'latest'}`})`]
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
        case 'publish':
          return await publish(rest, cwd)
        case 'history':
          return await history(rest, cwd)
        case 'rollback':
          return await rollback(rest, cwd)
        case 'pin':
          return await pin(rest, cwd)
        case 'assets':
          return await listAssets()
        case 'add':
          return await addRef(rest, cwd)
        case 'promote':
          return await promote(rest, cwd)
        case 'import':
          return await importAsset(rest, cwd)
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

  /**
   * Preview or confirm a publish.
   * @param {string[]} args - `<flow> [confirm]`.
   * @param {string | null} cwd - workspace root.
   * @returns {Promise<{kind: string, text: string}>} result.
   */
  async function publish(args, cwd) {
    const key = args[0]
    if (key === undefined) return { kind: 'error', text: '用法：/hnflow publish <流程> [confirm]' }
    const confirm = args[1] === 'confirm'
    if (confirm) {
      const resolved = await service.describeFlow(cwd, key)
      const published = await service.publish({ cwd, key, note: 'published by /hnflow' })
      return {
        kind: 'success',
        text: `已发布 ${resolved.alias || resolved.flowId} 为 r${published.revision}（${published.contentHash}）。\n钉住旧版本的引用不会自动跟随；需要时用 /hnflow pin 改钉。`,
      }
    }
    const preview = await service.previewPublish(cwd, key)
    const lines = [
      `流程 ${preview.alias || preview.flowId}（${preview.flowId}）`,
      `来源：${preview.source}，当前 r${preview.currentRevision}，发布后为 r${preview.nextRevision}`,
      `校验：${preview.validation.ok ? '通过' : `失败（${preview.validation.errors.length} 项）`}`,
      ...preview.validation.errors.map((entry) => `  × ${entry.code}${entry.nodeId ? ` [${entry.nodeId}]` : ''}: ${entry.message}`),
      '',
      ...(preview.diff?.changed === false ? ['变更：无内容变化'] : ['变更：', ...(preview.diff?.summary ?? []).map((line) => `  ${line}`)]),
    ]
    if (!preview.validation.ok) lines.push('', '修正后再执行 /hnflow publish。')
    else lines.push('', `确认发布：/hnflow publish ${key} confirm`)
    return { kind: 'success', text: lines.join('\n') }
  }

  /**
   * Show one flow's revision history.
   * @param {string[]} args - `<flow>`.
   * @param {string | null} cwd - workspace root.
   * @returns {Promise<{kind: string, text: string}>} result.
   */
  async function history(args, cwd) {
    const key = args[0]
    if (key === undefined) return { kind: 'error', text: '用法：/hnflow history <流程>' }
    const found = await service.history(cwd, key)
    const lines = [
      `流程 ${found.alias || found.flowId}（${found.flowId}）`,
      `当前 r${found.currentRevision}，引用${found.pinnedRevision === null ? '跟随最新' : `钉住 r${found.pinnedRevision}`}，来源 ${found.source}`,
      `版本（${found.revisions.length}）：`,
    ]
    for (const entry of found.revisions) {
      const mark = entry.revision === found.currentRevision ? ' ← 当前' : ''
      lines.push(`  r${entry.revision}${entry.revision === found.pinnedRevision ? '（引用）' : ''} ${entry.contentHash}${entry.snapshotAt ? ` @ ${entry.snapshotAt}` : ''}${mark}`)
    }
    return { kind: 'success', text: lines.join('\n') }
  }

  /**
   * Preview or confirm rolling an old revision forward as a new revision.
   * @param {string[]} args - `<flow> <rN> [confirm]`.
   * @param {string | null} cwd - workspace root.
   * @returns {Promise<{kind: string, text: string}>} result.
   */
  async function rollback(args, cwd) {
    const [key, target, confirm] = args
    if (key === undefined || target === undefined) return { kind: 'error', text: '用法：/hnflow rollback <流程> <rN> [confirm]' }
    const revision = Number(target.replace(/^r/u, ''))
    if (!Number.isInteger(revision) || revision < 1) return { kind: 'error', text: `无法识别的版本：${target}（用 r3）` }
    if (confirm !== 'confirm') {
      const found = await service.history(cwd, key)
      const entry = found.revisions.find((candidate) => candidate.revision === revision)
      if (entry === undefined) return { kind: 'error', text: `流程 ${key} 没有 r${revision} 的快照。` }
      return {
        kind: 'success',
        text: [
          `回滚 ${found.alias || found.flowId}：把 r${revision}（${entry.contentHash}）发布为新的 r${found.currentRevision + 1}`,
          '历史不会被改写；旧 revision 仍保留。',
          `确认回滚：/hnflow rollback ${key} r${revision} confirm`,
        ].join('\n'),
      }
    }
    const restored = await service.rollback({ cwd, key, revision, note: `rollback to r${revision} by /hnflow` })
    return { kind: 'success', text: `已把 r${revision} 发布为 r${restored.revision}（${restored.contentHash}）。` }
  }

  /**
   * Re-pin a reference.
   * @param {string[]} args - `<flow> <latest|rN>`.
   * @param {string | null} cwd - workspace root.
   * @returns {Promise<{kind: string, text: string}>} result.
   */
  async function pin(args, cwd) {
    const [key, target] = args
    if (key === undefined || target === undefined) return { kind: 'error', text: '用法：/hnflow pin <流程> <latest|rN>' }
    const revision = target === 'latest' ? 'latest' : Number(target.replace(/^r/u, ''))
    if (revision !== 'latest' && (!Number.isInteger(revision) || revision < 1)) {
      return { kind: 'error', text: `无法识别的版本：${target}（用 latest 或 r3）` }
    }
    const updated = await service.pinRef(cwd, key, revision)
    return { kind: 'success', text: `${updated.alias || updated.flowId} 现在${updated.revision === null ? '跟随最新版本' : `钉住 r${updated.revision}`}。` }
  }

  /**
   * List the reusable library assets (not just this workspace's refs).
   * @returns {Promise<{kind: string, text: string}>} result.
   */
  async function listAssets() {
    const assets = await new AssetStore(libraryRoot(config), { logger }).list()
    if (assets.length === 0) return { kind: 'success', text: '通用资产库是空的。' }
    return {
      kind: 'success',
      text: assets
        .map((asset) => `- ${asset.name} (${asset.id}, r${asset.revision})${asset.description ? `：${asset.description}` : ''}`)
        .join('\n'),
    }
  }

  /**
   * Reference an existing library asset from this workspace (human action).
   * @param {string[]} args - `<flowId> [alias]`.
   * @param {string | null} cwd - workspace root.
   * @returns {Promise<{kind: string, text: string}>} result.
   */
  async function addRef(args, cwd) {
    const [flowId, alias] = args
    if (flowId === undefined) return { kind: 'error', text: '用法：/hnflow add <流程id> [别名]' }
    const assets = await new AssetStore(libraryRoot(config), { logger }).list()
    const asset = assets.find((entry) => entry.id === flowId || entry.name === flowId)
    if (asset === undefined) return { kind: 'error', text: `资产库里没有 ${flowId}；先用 /hnflow assets 查看。` }
    const { workspace } = createStores({ cwd, config, libraryRoot: libraryRoot(config), logger })
    const ref = await workspace.addRef({ flowId: asset.id, alias: alias ?? '', revision: null })
    return { kind: 'success', text: `已引用 ${asset.name} (${asset.id})${ref.alias ? `，别名 ${ref.alias}` : ''}，跟随最新版本。` }
  }

  /**
   * Promote a project-local draft into the library and reference it (human action).
   * @param {string[]} args - `<flow> [folder]`.
   * @param {string | null} cwd - workspace root.
   * @returns {Promise<{kind: string, text: string}>} result.
   */
  async function promote(args, cwd) {
    const [key, folder] = args
    if (key === undefined) return { kind: 'error', text: '用法：/hnflow promote <项目草稿> [目录]' }
    const promoted = await service.promote({ cwd, key, folder })
    return {
      kind: 'success',
      text: `已把 ${promoted.name} 提升为通用资产 ${promoted.flowId}（r1${promoted.folder ? `，目录 ${promoted.folder}` : ''}）并改为本工作区引用。\n后续修改仍需人工发布。`,
    }
  }

  /**
   * Import a definition file as a new asset and reference it (human action).
   *
   * Legacy `WorkflowDefinition` documents are converted best-effort first, and
   * the conversion report is shown before anything is written. A definition
   * that fails static validation is refused, so a half-converted flow never
   * enters the library.
   * @param {string[]} args - `<name> <file>`.
   * @param {string | null} cwd - workspace root.
   * @returns {Promise<{kind: string, text: string}>} result.
   */
  async function importAsset(args, cwd) {
    const [name, file] = args
    if (name === undefined || file === undefined) return { kind: 'error', text: '用法：/hnflow import <名称> <工作区内的 JSON 文件>' }
    const absolute = path.resolve(cwd, file)
    if (!absolute.startsWith(path.resolve(cwd) + path.sep)) {
      return { kind: 'error', text: '只允许导入工作区目录内的文件。' }
    }
    const parsed = JSON.parse(await readFile(absolute, 'utf8'))
    const { definition, report } = convertDefinition(parsed.definition ?? parsed)
    const reportLines = report.changed || report.legacy ? [formatImportReport(report), ''] : []
    const validation = await service.validate(definition)
    if (!validation.ok) {
      return {
        kind: 'error',
        text: [
          ...reportLines,
          `转换后的定义没有通过校验（${validation.errors.length} 项）：`,
          ...validation.errors.map((entry) => `  × ${entry.code}${entry.nodeId ? ` [${entry.nodeId}]` : ''}: ${entry.message}`),
          '',
          '没有写入资产库；原文件未修改。',
        ].join('\n'),
      }
    }
    const assets = new AssetStore(libraryRoot(config), { logger })
    const created = await assets.create({ name, definition, description: typeof definition.flow?.description === 'string' ? definition.flow.description : '' })
    const { workspace } = createStores({ cwd, config, libraryRoot: libraryRoot(config), logger })
    await workspace.addRef({ flowId: String(created.asset.id) })
    return {
      kind: 'success',
      text: [
        ...reportLines,
        `已导入 ${name}（${created.asset.id}，r1）并加入本工作区引用。`,
        `校验：通过（${validation.warnings.length} 条警告）`,
      ].join('\n'),
    }
  }

  return {
    name: COMMAND_NAME,
    description: 'HNFlow：列出流程 / 运行 / 收件箱 / 发布 / 钉版本',
    input: { hint: '[list|runs|status|inbox|publish|pin|import|open]' },
    handler,
  }
}
