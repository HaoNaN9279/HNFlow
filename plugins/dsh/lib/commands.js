/**
 * `/workflow` — the reference form; `/hnflow` — the page and library channel.
 *
 * DSH has no `@workflow` trigger syntax. A person who wants a workflow types
 * `/workflow <name> <prompt>`: the command resolves the name against this
 * workspace and hands the reference plus the prompt to the model as one user
 * message. The model then calls the `hnflow` tool, and the tool only starts the
 * run — the session never runs, follows, or answers a workflow.
 *
 * Running a workflow without a conversation is the HNFlow page's job, so there
 * is deliberately no `/workflow run`. Everything the page and the library need —
 * refs, assets, overrides, diagnostics — lives on `/hnflow`, which the resident
 * row registers in every session.
 */

import { existsSync } from 'node:fs'

import { diffDocuments } from './json.js'
import { engineCwd, enginePointerPath, readEnginePointer, resolvePython, writeEnginePointer } from './paths.js'
import { formatWorkflowList } from './tools.js'
import { dispatchUi } from './ui.js'

/** Usage text shown for `/workflow`, `/workflow help`, and every misuse. */
export const USAGE = [
  '/workflow <name> <prompt> — 把「工作流 <name>」和你的提示词交给 AI 启动（会话只负责启动）',
  '/workflow — 列出本工作区可用的工作流',
  '/workflow help — 显示这段用法',
].join('\n')

/** Usage text for the page and library channel. */
export const ADMIN_USAGE = [
  '/hnflow ui <op> <base64url payload> — HNFlow 页面的数据（界面调用）',
  '/hnflow ref list|add|remove|pin — 工作区引用',
  '/hnflow asset list|new|import|delete — 资产库',
  '/hnflow override diff|reset <name> — 工作区覆盖',
  '/hnflow save asset <name> [--yes] — 把覆盖写回资产（先给 diff）',
  '/hnflow node <name> <nodeId> <json> — 改一个节点的 params（写覆盖）',
  '/hnflow doctor [--python <path>] [--cwd <path>] [--save] — 引擎安装位置',
].join('\n')

/**
 * Split a raw command line into tokens, honouring double quotes.
 * @param {string} rawInput - text after the command name.
 * @returns {string[]} tokens.
 */
export function tokenize(rawInput) {
  const text = String(rawInput ?? '')
  /** @type {string[]} */
  const tokens = []
  let current = ''
  let quoted = false
  for (const character of text) {
    if (character === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && /\s/u.test(character)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += character
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}

/**
 * Ops the resident viewer row may run: data for the page, nothing else.
 *
 * The viewer lives outside the HNFlow preset, so it must not become a second
 * entry point for running workflows: there is no op that starts, cancels, or
 * answers a run.
 */
export const VIEWER_OPS = new Set(['ping', 'tree', 'canvas', 'assetCanvas', 'monitor', 'wait'])

/**
 * Build the `/hnflow` registration used by the resident viewer row.
 *
 * It serves the page (`ui`, read from the state files instead of the engine, so
 * it works with no HNFlow session open and never competes for the checkpoint
 * database) and the library the page edits (refs, assets, overrides), plus
 * `doctor` for the engine installation.
 * @param {{service: import('./service.js').HnflowService, cwdOf?: (agent: unknown) => string | null}} options - wiring.
 * @returns {{name: string, description: string, input: {hint: string}, handler: Function}} command definition.
 */
export function createViewerCommand(options) {
  const { service, cwdOf } = options
  return {
    name: 'hnflow',
    description: 'HNFlow page data and library management (available in every session)',
    input: { hint: 'ui <op> <base64url payload>' },
    handler: async (invocation) => {
      const rawInput = String(invocation?.rawInput ?? '')
      const tokens = tokenize(rawInput)
      if (tokens[0] === 'ui') {
        try {
          return { kind: 'success', text: await dispatchUi(tokens.slice(1), { service, ops: VIEWER_OPS, fromFiles: true, label: '/hnflow ui' }) }
        } catch (error) {
          return { kind: 'error', text: `hnflow: ${error?.code ?? 'error'}: ${error?.message ?? String(error)}` }
        }
      }
      if (tokens[0] === 'doctor') {
        try {
          return { kind: 'success', text: doctorCommand(tokens.slice(1), service) }
        } catch (error) {
          return { kind: 'error', text: `hnflow: ${error?.code ?? 'error'}: ${error?.message ?? String(error)}` }
        }
      }
      const cwd = typeof cwdOf === 'function' ? cwdOf(invocation?.agent) : null
      if (cwd === null) {
        return { kind: 'error', text: tokens.length === 0 ? ADMIN_USAGE : 'hnflow: this session has no workspace directory' }
      }
      try {
        return { kind: 'success', text: await adminCommand(tokens, rawInput, cwd, service) }
      } catch (error) {
        return { kind: 'error', text: `hnflow: ${error?.code ?? 'error'}: ${error?.message ?? String(error)}` }
      }
    },
  }
}

/**
 * Compose the user message that names one workflow and carries the request.
 *
 * The tag is the contract between this command and the model: the prompt
 * section and the bundled skill both say that a message starting with
 * `<hnflow_workflow …/>` asks for that exact workflow, started through the
 * `hnflow` tool. Everything after the tag is the person's own prompt, verbatim.
 * @param {{key: string, assetId: string, revision: number | null, source?: string}} reference - resolved workflow.
 * @param {string} request - the person's prompt.
 * @returns {string} the model-facing user message.
 */
export function composeWorkflowPrompt(reference, request) {
  const attributes = [
    `name="${escapeAttribute(reference.key)}"`,
    `asset="${escapeAttribute(reference.assetId)}"`,
    reference.revision === null || reference.revision === undefined ? '' : `revision="${reference.revision}"`,
    typeof reference.source === 'string' && reference.source.length > 0 ? `source="${escapeAttribute(reference.source)}"` : '',
  ].filter((part) => part.length > 0)
  return [`<hnflow_workflow ${attributes.join(' ')} />`, '', request].join('\n')
}

/**
 * Escape one attribute value for the reference tag.
 * @param {string} value - raw text.
 * @returns {string} text safe inside double quotes.
 */
function escapeAttribute(value) {
  return String(value ?? '').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Build the `/workflow` command registration.
 * @param {{
 *   service: import('./service.js').HnflowService,
 *   cwdOf: (agent: unknown) => string | null,
 *   startTurn: (agent: unknown, text: string) => Promise<void>,
 * }} options - wiring.
 * @returns {{name: string, description: string, input: {hint: string}, handler: Function}} command definition.
 */
export function createWorkflowCommand(options) {
  const { service, cwdOf, startTurn } = options

  /**
   * Execute one command invocation.
   * @param {{agent?: unknown, rawInput?: string}} invocation - command payload.
   * @returns {Promise<{kind: 'success'|'error', text: string}>} command result.
   */
  const handler = async (invocation) => {
    const rawInput = String(invocation?.rawInput ?? '')
    const tokens = tokenize(rawInput)
    // `ui` is the browser surfaces' channel: a global page has no session, so
    // this branch must run before the workspace lookup rejects the invocation.
    if (tokens[0] === 'ui') {
      try {
        return { kind: 'success', text: await dispatchUi(tokens.slice(1), { service }) }
      } catch (error) {
        return { kind: 'error', text: `workflow: ${error?.code ?? 'error'}: ${error?.message ?? String(error)}` }
      }
    }

    const cwd = cwdOf(invocation?.agent)
    if (cwd === null) return { kind: 'error', text: 'workflow: this session has no workspace directory' }

    if (tokens.length === 0 || tokens[0] === 'help') {
      try {
        return { kind: 'success', text: `${USAGE}\n\n${formatWorkflowList(await service.listWorkflows(cwd))}` }
      } catch {
        return { kind: 'success', text: USAGE }
      }
    }

    // The request is taken from the raw remainder, not from the tokens: quotes,
    // newlines, and spacing are the person's own prose and must survive.
    const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(rawInput.trim())
    const key = match?.[1] ?? ''
    const request = (match?.[2] ?? '').trim()
    if (request.length === 0) {
      return { kind: 'error', text: `workflow: usage: /workflow ${key} <提示词>（说明这次要用这个工作流做什么）` }
    }

    let resolved
    try {
      resolved = await service.resolve(cwd, key)
    } catch (error) {
      if (error?.code === 'ref-missing') {
        const available = await service.listWorkflows(cwd).catch(() => [])
        return {
          kind: 'error',
          text: [`workflow: ref-missing: 本工作区没有引用名叫 ${key} 的工作流`, formatWorkflowList(available)].join('\n'),
        }
      }
      return { kind: 'error', text: `workflow: ${error?.code ?? 'error'}: ${error?.message ?? String(error)}` }
    }

    const text = composeWorkflowPrompt(
      { key, assetId: resolved.assetId, revision: Number.isInteger(resolved.revision) ? resolved.revision : null, source: resolved.source },
      request,
    )
    try {
      await startTurn(invocation?.agent, text)
    } catch (error) {
      return { kind: 'error', text: `workflow: ${error?.code ?? 'turn-unavailable'}: ${error?.message ?? String(error)}` }
    }
    const revision = Number.isInteger(resolved.revision) ? `r${resolved.revision}` : 'latest'
    return { kind: 'success', text: `已交给 AI：${key}（${resolved.assetId}，${revision}）。会话只负责启动。` }
  }

  return {
    name: 'workflow',
    description: 'Hand one HNFlow workflow from this workspace to the AI, with your prompt (the session only starts it)',
    input: { hint: '<name> <prompt…>' },
    handler,
  }
}

/**
 * Route one `/hnflow` administrative line.
 * @param {string[]} tokens - command tokens.
 * @param {string} rawInput - text after the command name.
 * @param {string} cwd - workspace root.
 * @param {Record<string, any>} service - plugin service.
 * @returns {Promise<string>} output text.
 */
async function adminCommand(tokens, rawInput, cwd, service) {
  const [head, ...rest] = tokens
  if (head === undefined || head === 'help') return `${ADMIN_USAGE}\n\n${formatWorkflowList(await service.listWorkflows(cwd))}`
  if (head === 'ref') return await refCommand(rest, cwd, service)
  if (head === 'asset') return await assetCommand(rest, cwd, service)
  if (head === 'override') return await overrideCommand(rest, cwd, service)
  if (head === 'save') {
    const [what, key, ...flags] = rest
    if (what !== 'asset' || key === undefined) throw commandError('usage', 'usage: /hnflow save asset <name> [--yes]')
    if (!flags.includes('--yes')) {
      const stores = service.storesFor(cwd)
      const resolved = await service.resolve(cwd, key)
      if (resolved.source !== 'override') throw commandError('nothing-to-save', `${key} has no workspace override to save`)
      const asset = await stores.assets.read(resolved.assetId)
      return [
        `this would write ${key} back to ${resolved.assetId}: r${resolved.currentRevision} → r${resolved.currentRevision + 1}`,
        formatOverrideDiff({ assetId: resolved.assetId, baseRevision: resolved.currentRevision, definition: resolved.definition }, asset.definition),
        'rerun with --yes to save',
      ].join('\n')
    }
    const saved = await service.saveAsset({ cwd, key, note: `saved from ${key}` })
    return [`saved ${saved.name} (${saved.assetId}) as revision ${saved.revision} (was r${saved.previousRevision})`, 'this workspace ref may now be behind the asset: run /hnflow ref list to check drift'].join('\n')
  }
  if (head === 'node') return await nodeCommand(rawInput, cwd, service)
  throw commandError('unknown-subcommand', ADMIN_USAGE)
}

/**
 * `/hnflow node <name> <nodeId> <json>`
 *
 * The JSON is taken from the raw remainder so quoted values survive tokenizing.
 * @param {string} rawInput - text after the command name.
 * @param {string} cwd - workspace root.
 * @param {Record<string, any>} service - plugin service.
 * @returns {Promise<string>} output text.
 */
async function nodeCommand(rawInput, cwd, service) {
  const match = /^node\s+(\S+)\s+(\S+)\s+([\s\S]+)$/u.exec(String(rawInput ?? '').trim())
  if (match === null) throw commandError('usage', 'usage: /hnflow node <name> <nodeId> <json>')
  const [, key, nodeId, json] = match
  let params
  try {
    params = JSON.parse(json)
  } catch (error) {
    throw commandError('params-invalid', `params must be valid JSON: ${error.message}`)
  }
  const result = await service.setNodeParams({ cwd, key, nodeId, params })
  return `updated ${result.nodeId} in the workspace override for ${result.key} (base r${result.baseRevision})`
}

/**
 * `/hnflow ref …`
 * @param {string[]} tokens - tokens after `ref`.
 * @param {string} cwd - workspace root.
 * @param {Record<string, any>} service - plugin service.
 * @returns {Promise<string>} output text.
 */
async function refCommand(tokens, cwd, service) {
  const [action, ...rest] = tokens
  const stores = service.storesFor(cwd)
  if (action === undefined || action === 'list') {
    return formatWorkflowList(await service.listWorkflows(cwd))
  }
  if (action === 'add') {
    const assetId = rest[0]
    if (assetId === undefined) throw commandError('asset-required', 'usage: /hnflow ref add <assetId> [--pin N] [--alias name]')
    /** @type {{pin: number|null, alias: string}} */
    const options = { pin: null, alias: '' }
    for (let index = 1; index < rest.length; index += 1) {
      if (rest[index] === '--pin') {
        const value = Number(rest[index + 1])
        if (!Number.isInteger(value) || value <= 0) throw commandError('invalid-pin', '--pin expects a positive integer revision')
        options.pin = value
        index += 1
      } else if (rest[index] === '--alias') {
        options.alias = rest[index + 1] ?? ''
        index += 1
      }
    }
    const asset = await stores.assets.read(assetId)
    const ref = await stores.workspace.addRef({ assetId, alias: options.alias, revision: options.pin ?? Number(asset.asset.revision ?? 1) })
    const pinned = Number.isInteger(ref.revision) ? `r${ref.revision}` : 'latest'
    return `referenced ${asset.asset.name} (${assetId}) at ${pinned}${ref.alias ? ` as ${ref.alias}` : ''}`
  }
  if (action === 'remove') {
    const key = rest[0]
    if (key === undefined) throw commandError('ref-required', 'usage: /hnflow ref remove <name>')
    const removed = await stores.workspace.removeRef(key)
    return `removed reference ${removed.alias || removed.assetId}`
  }
  if (action === 'pin') {
    const key = rest[0]
    if (key === undefined) throw commandError('ref-required', 'usage: /hnflow ref pin <name> [--to N]')
    const target = rest.indexOf('--to')
    const requested = target >= 0 ? Number(rest[target + 1]) : undefined
    if (target >= 0 && (!Number.isInteger(requested) || requested <= 0)) {
      throw commandError('invalid-pin', '--to expects a positive integer revision')
    }
    const pinned = await service.repinRef({ cwd, key, revision: requested })
    return pinned.revision === null ? `${key} now follows the latest revision (r${pinned.currentRevision})` : `${key} pinned to r${pinned.revision} (asset is at r${pinned.currentRevision})`
  }
  throw commandError('unknown-subcommand', 'usage: /hnflow ref list|add|remove|pin')
}

/**
 * `/hnflow asset …`
 * @param {string[]} tokens - tokens after `asset`.
 * @param {string} cwd - workspace root.
 * @param {Record<string, any>} service - plugin service.
 * @returns {Promise<string>} output text.
 */
async function assetCommand(tokens, cwd, service) {
  const [action, ...rest] = tokens
  if (action === undefined || action === 'list') {
    const assets = await service.listAssets(cwd)
    if (assets.length === 0) return 'the library has no workflow assets yet'
    return assets.map((asset) => `${asset.id}  r${asset.revision}  ${asset.name}`).join('\n')
  }
  if (action === 'new') {
    const name = rest[0]
    if (name === undefined) throw commandError('asset-required', 'usage: /hnflow asset new <name> [--folder dir]')
    const folderIndex = rest.indexOf('--folder')
    const folder = folderIndex >= 0 ? (rest[folderIndex + 1] ?? '') : ''
    const created = await service.createAsset({ cwd, name, folder })
    return `created ${created.name} (${created.assetId}, r${created.revision})\nadd it with: /hnflow ref add ${created.assetId} --alias <name>`
  }
  if (action === 'import') {
    const file = rest[0]
    if (file === undefined) throw commandError('path-required', 'usage: /hnflow asset import <path> [--name name]')
    const nameIndex = rest.indexOf('--name')
    const name = nameIndex >= 0 ? rest[nameIndex + 1] : undefined
    const imported = await service.importAsset({ cwd, path: file, name })
    return `imported ${imported.name} as ${imported.assetId} (r${imported.revision}) from ${imported.source}`
  }
  if (action === 'delete') {
    const assetId = rest[0]
    if (assetId === undefined) throw commandError('asset-required', 'usage: /hnflow asset delete <assetId>')
    const removed = await service.deleteAsset({ cwd, assetId })
    return `deleted ${removed.assetId}${removed.hadOverride ? ' (its workspace override was removed too)' : ''}`
  }
  throw commandError('unknown-subcommand', 'usage: /hnflow asset list|new|import|delete')
}

/**
 * `/hnflow override …`
 * @param {string[]} tokens - tokens after `override`.
 * @param {string} cwd - workspace root.
 * @param {Record<string, any>} service - plugin service.
 * @returns {Promise<string>} output text.
 */
async function overrideCommand(tokens, cwd, service) {
  const [action, key] = tokens
  if (key === undefined) throw commandError('workflow-required', 'usage: /hnflow override diff|reset <name>')
  const stores = service.storesFor(cwd)
  const resolved = await service.resolve(cwd, key)
  const override = await stores.workspace.readOverride(resolved.assetId)
  if (action === 'diff') {
    if (override === null) return `${key} has no workspace override`
    const asset = await stores.assets.read(resolved.assetId)
    return formatOverrideDiff(override, asset.definition)
  }
  if (action === 'reset') {
    const result = await service.resetOverride({ cwd, key })
    return result.removed ? `dropped the override for ${key}` : `${key} had no override`
  }
  throw commandError('unknown-subcommand', 'usage: /hnflow override diff|reset <name>')
}

/**
 * Compare the workspace override against the asset's current revision.
 * @param {Record<string, any>} override - override document (`{assetId, baseRevision, definition}`).
 * @param {Record<string, any>} asset - asset definition to compare against.
 * @returns {string} model-facing summary.
 */
export function formatOverrideDiff(override, asset) {
  const changes = diffDocuments(asset, override.definition, { maxEntries: 20 })
  const header = `override for ${override.assetId} (base r${override.baseRevision}), ${changes.length} change(s)`
  if (changes.length === 0) return `${header}\nno difference from the asset definition`
  const lines = changes.map((change) => `- ${change.path}: ${JSON.stringify(change.from)} → ${JSON.stringify(change.to)}`)
  return [header, ...lines].join('\n')
}

/**
 * `/hnflow doctor [--python <path>] [--cwd <path>] [--save]`
 *
 * Reports how the engine would be started, and records an installation when
 * asked. Needed because the plugin ships as an installed copy: the checkout
 * that holds the virtualenv and the `deerflow` package is not discoverable
 * from `node_modules`.
 * @param {string[]} tokens - arguments after `doctor`.
 * @param {Record<string, any>} service - plugin service.
 * @returns {string} report text.
 */
export function doctorCommand(tokens, service) {
  /** @type {{python: string | null, cwd: string | null, save: boolean}} */
  const options = { python: null, cwd: null, save: false }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--save') options.save = true
    else if (token === '--python') options.python = tokens[(index += 1)] ?? null
    else if (token === '--cwd') options.cwd = tokens[(index += 1)] ?? null
    else throw commandError('usage', 'usage: /hnflow doctor [--python <path>] [--cwd <path>] [--save]')
  }

  const config = service.config ?? {}
  const python = options.python ?? resolvePython(config)
  const cwd = options.cwd ?? engineCwd(config)
  const pointer = enginePointerPath()
  const recorded = readEnginePointer()

  if (options.save) {
    if (python === null || !existsSync(python)) throw commandError('engine-python-missing', `no interpreter at ${python ?? '(none)'}`)
    if (!existsSync(cwd)) throw commandError('engine-cwd-missing', `no engine directory at ${cwd}`)
    const written = writeEnginePointer({ python, cwd })
    service.resetEngine?.()
    return [`recorded engine installation:`, `  python: ${python}`, `  cwd:    ${cwd}`, `  file:   ${written}`].join('\n')
  }

  return [
    'engine installation',
    `  python:  ${python ?? '(not found)'}${python !== null && existsSync(python) ? '' : '  ← missing'}`,
    `  cwd:     ${cwd}${existsSync(cwd) ? '' : '  ← missing'}`,
    `  module:  ${config.engineModule ?? 'deerflow.workflow.rpc'}`,
    `  record:  ${pointer}${recorded === null ? ' (none)' : ` → ${recorded.python ?? '?'}`}`,
    `  env:     DSH_HNFLOW_PYTHON=${process.env.DSH_HNFLOW_PYTHON ?? ''}`,
    '',
    'an installed copy cannot find the repository by itself; record it once:',
    '  /hnflow doctor --python <backend/.venv/Scripts/python.exe> --cwd <repo>/backend --save',
  ].join('\n')
}

/**
 * Build a coded command error.
 * @param {string} code - stable code.
 * @param {string} message - usage hint.
 * @returns {Error & {code: string}} the error.
 */
function commandError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}
