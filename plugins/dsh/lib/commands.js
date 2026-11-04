/**
 * `/workflow` — the deterministic entry point.
 *
 * DSH has no `@workflow` trigger syntax, so an explicit workflow is named here
 * (or in the panel, or in prose). A command runs on the host: it returns text,
 * never a model turn, which is what makes "run this workflow now" exact.
 */

import { existsSync } from 'node:fs'

import { diffDocuments } from './json.js'
import { engineCwd, enginePointerPath, readEnginePointer, resolvePython, writeEnginePointer } from './paths.js'
import { formatRunStatus, formatTasks, formatTimeline, formatWorkflowList } from './tools.js'
import { dispatchUi } from './ui.js'

/** Usage text shown for `/workflow` and `/workflow help`. */
export const USAGE = [
  '/workflow — list workflows referenced by this workspace',
  '/workflow panel [name] — JSON payload for the HNFlow panel (list + one definition)',
  '/workflow run <name> [k=v …] — start a run and wait for it (or for a human task)',
  '/workflow status <runId> — show a run and its pending tasks',
  '/workflow events <runId> — the node timeline of a run',
  '/workflow cancel <runId> — ask the engine to stop a run',
  '/workflow resume <runId> — continue a run an engine restart interrupted',
  '/workflow tasks [runId] — pending human tasks',
  '/workflow inbox — the same tasks as a JSON payload for the panel',
  '/workflow submit <taskId> [k=v …|{json}] — answer a human task and continue the run',
  '/workflow ref list — refs, overrides, and drift',
  '/workflow ref add <assetId> [--pin N] [--alias name] — add a reference',
  '/workflow ref remove <name> — drop a reference',
  '/workflow ref pin <name> [--to N] — move a reference to the current (or given) revision',
  '/workflow asset list — the asset library',
  '/workflow asset new <name> [--folder dir] — create an empty workflow asset',
  '/workflow asset import <path> [--name name] — import a workflow file as a new asset',
  '/workflow asset delete <assetId> — delete an unreferenced asset',
  '/workflow save asset <name> [--yes] — write the workspace override back to the asset (dry run + explicit --yes)',
  '/workflow override diff <name> — override vs asset',
  '/workflow override reset <name> — drop the workspace override',
  '/workflow node <name> <nodeId> <json> — set one node\'s params in the workspace override',
  '/workflow ui <op> [base64url payload] — JSON for the browser surfaces (works without a session)',
  '/workflow doctor [--python <path>] [--cwd <path>] [--save] — where the engine comes from (and record it)',
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
 * Pull `--session <id>` / `--session=<id>` out of a run's arguments.
 *
 * The run record carries the session id so the monitor can name the session
 * that started it; a bare command has no session object to ask.
 * @param {string[]} tokens - remaining tokens.
 * @returns {{rest: string[], sessionId: string | null}} tokens without the option, and its value.
 */
export function extractSessionOption(tokens) {
  /** @type {string[]} */
  const rest = []
  /** @type {string | null} */
  let sessionId = null
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--session') {
      const value = tokens[index + 1]
      if (typeof value === 'string' && !value.startsWith('--')) {
        sessionId = value
        index += 1
      }
      continue
    }
    if (token.startsWith('--session=')) {
      sessionId = token.slice('--session='.length)
      continue
    }
    rest.push(token)
  }
  return { rest, sessionId }
}

/**
 * Parse `key=value` pairs into a run input object.
 * @param {string[]} tokens - remaining tokens.
 * @returns {{input: Record<string, unknown>, rest: string[]}} parsed pairs and leftovers.
 */
export function parseInputs(tokens) {
  /** @type {Record<string, unknown>} */
  const input = {}
  /** @type {string[]} */
  const rest = []
  for (const token of tokens) {
    const index = token.indexOf('=')
    if (index <= 0) {
      rest.push(token)
      continue
    }
    const key = token.slice(0, index)
    const raw = token.slice(index + 1)
    try {
      input[key] = JSON.parse(raw)
    } catch {
      input[key] = raw
    }
  }
  return { input, rest }
}

/**
 * Compare the workspace override against the asset's current revision.
 * @param {Record<string, any>} resolved - resolution result for the override path is not used here.
 * @param {Record<string, any>} override - override document.
 * @param {Record<string, any>} asset - asset definition.
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
 * Build the `/workflow` command registration.
 * @param {{service: import('./service.js').HnflowService, cwdOf: (agent: unknown) => string | null}} options - wiring.
 * @returns {{name: string, description: string, input: {hint: string}, handler: Function}} command definition.
 */
export function createWorkflowCommand(options) {
  const { service, cwdOf } = options

  /**
   * Execute one command invocation.
   * @param {{agent?: unknown, rawInput?: string}} invocation - command payload.
   * @returns {Promise<{kind: 'success'|'error', text: string}>} command result.
   */
  const handler = async (invocation) => {
    const rawInput = invocation?.rawInput
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
    try {
      const text = await dispatch(tokens, cwd, rawInput)
      return { kind: 'success', text }
    } catch (error) {
      return { kind: 'error', text: `workflow: ${error?.code ?? 'error'}: ${error?.message ?? String(error)}` }
    }
  }

  /**
   * Route a parsed command line.
   * @param {string[]} tokens - command tokens.
   * @param {string} cwd - workspace root.
   * @returns {Promise<string>} output text.
   */
  const dispatch = async (tokens, cwd, rawInput) => {
    const [head, ...rest] = tokens
    if (head === undefined || head === 'list') return formatWorkflowList(await service.listWorkflows(cwd))
    if (head === 'help') return USAGE
    if (head === 'node') return await nodeCommand(rawInput, cwd)

    if (head === 'panel') return JSON.stringify(await service.panelPayload(cwd, rest[0]))

    if (head === 'run') {
      const { rest: withoutSession, sessionId } = extractSessionOption(rest)
      const { input, rest: positional } = parseInputs(withoutSession)
      const key = positional[0]
      if (key === undefined) throw commandError('workflow-required', 'usage: /workflow run <name> [k=v …] [--session <id>]')
      const started = await service.startRun({ cwd, key, inputs: input, ...(sessionId === null ? {} : { sessionId }) })
      const status = await service.waitFor(started.runId, 60000)
      const note =
        status.status === 'waiting_human'
          ? `\n(waiting for a human task; use /workflow tasks ${started.runId})`
          : status.status === 'succeeded' || status.status === 'failed' || status.status === 'cancelled'
            ? ''
            : `\n(still running; use /workflow status ${started.runId})`
      return `${formatRunStatus(status)}\nsource: ${started.resolved.source} r${started.resolved.revision ?? 'latest'}${note}`
    }

    if (head === 'status') {
      if (rest[0] === undefined) throw commandError('run-id-required', 'usage: /workflow status <runId>')
      return formatRunStatus(await service.status(rest[0]))
    }

    if (head === 'events') {
      if (rest[0] === undefined) throw commandError('run-id-required', 'usage: /workflow events <runId>')
      return formatTimeline(await service.events(rest[0], 0))
    }

    if (head === 'cancel') {
      if (rest[0] === undefined) throw commandError('run-id-required', 'usage: /workflow cancel <runId>')
      const result = await service.cancel(rest[0])
      return `${result.runId}: cancel requested=${result.cancelled} (status ${result.status})`
    }

    if (head === 'tasks') {
      const result = await service.tasks(rest[0])
      return formatTasks(result.tasks)
    }

    if (head === 'doctor') return doctorCommand(rest, service)

    if (head === 'inbox') return JSON.stringify(await service.tasks(undefined))
    if (head === 'resume') {
      if (rest[0] === undefined) throw commandError('run-id-required', 'usage: /workflow resume <runId>')
      const resumed = await service.resume(rest[0])
      const status = await service.waitFor(resumed.runId, 60000)
      return `resumed ${resumed.runId}\n${formatRunStatus(status)}`
    }

    if (head === 'submit') {
      const { taskId, payload } = parseSubmission(rawInput, rest)
      if (taskId === undefined) throw commandError('task-id-required', 'usage: /workflow submit <taskId> [k=v …|{json}]')
      const submitted = await service.submitTask({ taskId, payload })
      const status = await service.waitFor(submitted.runId, 60000)
      return `submitted ${taskId}\n${formatRunStatus(status)}`
    }

    if (head === 'ref') return await refCommand(rest, cwd)
    if (head === 'asset') return await assetCommand(rest, cwd)
    if (head === 'save') {
      const [what, key, ...flags] = rest
      if (what !== 'asset' || key === undefined) throw commandError('usage', 'usage: /workflow save asset <name> [--yes]')
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
      return [
        `saved ${saved.name} (${saved.assetId}) as revision ${saved.revision} (was r${saved.previousRevision})`,
        'this workspace ref may now be behind the asset: run /workflow ref list to check drift',
      ].join('\n')
    }

    if (head === 'override') return await overrideCommand(rest, cwd)

    throw commandError('unknown-subcommand', USAGE)
  }

  /**
   * `/workflow doctor [--python <path>] [--cwd <path>] [--save]`
   *
   * Reports how the engine would be started, and records an installation when
   * asked. Needed because the plugin ships as an installed copy: the checkout
   * that holds the virtualenv and the `deerflow` package is not discoverable
   * from `node_modules`.
   * @param {string[]} tokens - arguments after `doctor`.
   * @param {import('./service.js').HnflowService} service - plugin service.
   * @returns {string} report text.
   */
  const doctorCommand = (tokens, service) => {
    /** @type {{python: string | null, cwd: string | null, save: boolean}} */
    const options = { python: null, cwd: null, save: false }
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]
      if (token === '--save') options.save = true
      else if (token === '--python') options.python = tokens[(index += 1)] ?? null
      else if (token === '--cwd') options.cwd = tokens[(index += 1)] ?? null
      else throw commandError('usage', 'usage: /workflow doctor [--python <path>] [--cwd <path>] [--save]')
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
      return [`recorded engine installation:`, `  python: ${python}`, `  cwd:    ${cwd}`, `  file:   ${written}`, 'restart the session commands with /workflow status <runId> or run again'].join('\n')
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
      '  /workflow doctor --python <backend/.venv/Scripts/python.exe> --cwd <repo>/backend --save',
    ].join('\n')
  }

  /**
   * `/workflow node <name> <nodeId> <json>`
   *
   * The JSON is taken from the raw remainder so quoted values survive tokenizing.
   * @param {string} rawInput - text after the command name.
   * @param {string} cwd - workspace root.
   * @returns {Promise<string>} output text.
   */
  const nodeCommand = async (rawInput, cwd) => {
    const match = /^node\s+(\S+)\s+(\S+)\s+([\s\S]+)$/u.exec(String(rawInput ?? '').trim())
    if (match === null) throw commandError('usage', 'usage: /workflow node <name> <nodeId> <json>')
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
   * `/workflow ref …`
   * @param {string[]} tokens - tokens after `ref`.
   * @param {string} cwd - workspace root.
   * @returns {Promise<string>} output text.
   */
  const refCommand = async (tokens, cwd) => {
    const [action, ...rest] = tokens
    const stores = service.storesFor(cwd)
    if (action === undefined || action === 'list') {
      return formatWorkflowList(await service.listWorkflows(cwd))
    }
    if (action === 'add') {
      const assetId = rest[0]
      if (assetId === undefined) throw commandError('asset-required', 'usage: /workflow ref add <assetId> [--pin N] [--alias name]')
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
      if (key === undefined) throw commandError('ref-required', 'usage: /workflow ref remove <name>')
      const removed = await stores.workspace.removeRef(key)
      return `removed reference ${removed.alias || removed.assetId}`
    }
    if (action === 'pin') {
      const key = rest[0]
      if (key === undefined) throw commandError('ref-required', 'usage: /workflow ref pin <name> [--to N]')
      const target = rest.indexOf('--to')
      const requested = target >= 0 ? Number(rest[target + 1]) : undefined
      if (target >= 0 && (!Number.isInteger(requested) || requested <= 0)) {
        throw commandError('invalid-pin', '--to expects a positive integer revision')
      }
      const pinned = await service.repinRef({ cwd, key, revision: requested })
      return pinned.revision === null ? `${key} now follows the latest revision (r${pinned.currentRevision})` : `${key} pinned to r${pinned.revision} (asset is at r${pinned.currentRevision})`
    }
    throw commandError('unknown-subcommand', 'usage: /workflow ref list|add|remove|pin')
  }

  /**
   * `/workflow asset …`
   * @param {string[]} tokens - tokens after `asset`.
   * @param {string} cwd - workspace root.
   * @returns {Promise<string>} output text.
   */
  const assetCommand = async (tokens, cwd) => {
    const [action, ...rest] = tokens
    if (action === undefined || action === 'list') {
      const assets = await service.listAssets(cwd)
      if (assets.length === 0) return 'the library has no workflow assets yet'
      return assets.map((asset) => `${asset.id}  r${asset.revision}  ${asset.name}`).join('\n')
    }
    if (action === 'new') {
      const name = rest[0]
      if (name === undefined) throw commandError('asset-required', 'usage: /workflow asset new <name> [--folder dir]')
      const folderIndex = rest.indexOf('--folder')
      const folder = folderIndex >= 0 ? (rest[folderIndex + 1] ?? '') : ''
      const created = await service.createAsset({ cwd, name, folder })
      return `created ${created.name} (${created.assetId}, r${created.revision})\nadd it with: /workflow ref add ${created.assetId} --alias <name>`
    }
    if (action === 'import') {
      const file = rest[0]
      if (file === undefined) throw commandError('path-required', 'usage: /workflow asset import <path> [--name name]')
      const nameIndex = rest.indexOf('--name')
      const name = nameIndex >= 0 ? rest[nameIndex + 1] : undefined
      const imported = await service.importAsset({ cwd, path: file, name })
      return `imported ${imported.name} as ${imported.assetId} (r${imported.revision}) from ${imported.source}`
    }
    if (action === 'delete') {
      const assetId = rest[0]
      if (assetId === undefined) throw commandError('asset-required', 'usage: /workflow asset delete <assetId>')
      const removed = await service.deleteAsset({ cwd, assetId })
      return `deleted ${removed.assetId}${removed.hadOverride ? ' (its workspace override was removed too)' : ''}`
    }
    throw commandError('unknown-subcommand', 'usage: /workflow asset list|new|import|delete')
  }

  /**
   * `/workflow override …`
   * @param {string[]} tokens - tokens after `override`.
   * @param {string} cwd - workspace root.
   * @returns {Promise<string>} output text.
   */
  const overrideCommand = async (tokens, cwd) => {
    const [action, key] = tokens
    if (key === undefined) throw commandError('workflow-required', 'usage: /workflow override diff|reset <name>')
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
    throw commandError('unknown-subcommand', 'usage: /workflow override diff|reset <name>')
  }

  return {
    name: 'workflow',
    description: 'HNFlow workflows referenced by this workspace (list / run / status / cancel / ref / override)',
    input: { hint: '[list|run <name>|status <runId>|cancel <runId>|ref …|override …]' },
    handler,
  }
}

/**
 * Parse `/workflow submit <taskId> …` in either `k=v` or JSON form.
 *
 * The panel sends one JSON object (so a value may contain spaces); a person at
 * the prompt can keep typing `note=ok`.
 * @param {string} rawInput - text after the command name.
 * @param {string[]} tokens - tokenized remaining words.
 * @returns {{taskId: string | undefined, payload: Record<string, any>}} submission.
 */
export function parseSubmission(rawInput, tokens) {
  const match = /^submit\s+(\S+)\s*([\s\S]*)$/u.exec(String(rawInput ?? '').trim())
  if (match === null) return { taskId: undefined, payload: {} }
  const taskId = match[1]
  const remainder = match[2].trim()
  if (remainder.length === 0) return { taskId, payload: {} }
  if (remainder.startsWith('{')) {
    let payload
    try {
      payload = JSON.parse(remainder)
    } catch (error) {
      throw commandError('payload-invalid', `payload must be valid JSON: ${error.message}`)
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw commandError('payload-invalid', 'payload must be a JSON object')
    }
    return { taskId, payload }
  }
  return { taskId, payload: parseInputs(tokens.slice(1)).input }
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
