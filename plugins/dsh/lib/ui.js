/**
 * `/workflow ui` — the one command the browser surfaces call.
 *
 * A page, a session tab, and a right-sidebar panel all need the same data and
 * none of them may read files or talk to the engine directly. So the client
 * sends one line — `/workflow ui <op> <base64url(JSON)>` — and the host answers
 * with one JSON payload. base64url keeps Windows backslashes, spaces, and
 * quotes out of the command grammar.
 *
 * Ops are added per milestone; `ping` exists so a probe build can prove which
 * client surface actually mounted (see plan §14.2 / M6.0).
 */

import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

import { dshHome } from './paths.js'

/** Error carrying a stable code for the command layer. */
export class UiError extends Error {
  /**
   * @param {string} code - stable code (`ui-unreadable`, `ui-op`, …).
   * @param {string} message - human-readable message.
   */
  constructor(code, message) {
    super(message)
    this.name = 'UiError'
    this.code = code
  }
}

/**
 * Encode a payload for the command line.
 * @param {unknown} value - JSON-serializable payload.
 * @returns {string} base64url text without padding.
 */
export function encodePayload(value) {
  return Buffer.from(JSON.stringify(value ?? {}), 'utf8').toString('base64url')
}

/**
 * Decode a command-line payload.
 * @param {string | undefined} text - base64url text.
 * @returns {Record<string, any>} the payload (empty object when absent).
 */
export function decodePayload(text) {
  if (text === undefined || text === '') return {}
  let decoded
  try {
    decoded = Buffer.from(String(text), 'base64url').toString('utf8')
  } catch (error) {
    throw new UiError('ui-unreadable', `payload is not base64url: ${error.message}`)
  }
  let parsed
  try {
    parsed = JSON.parse(decoded)
  } catch {
    throw new UiError('ui-unreadable', 'payload is not JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new UiError('ui-unreadable', 'payload must be a JSON object')
  return parsed
}

/**
 * The probe log the client writes into, used to prove a surface mounted.
 * @returns {string} absolute path.
 */
export function spikeLogPath() {
  return path.join(dshHome(), 'hnflow', 'spike.log')
}

/**
 * Append one probe event.
 * @param {{surface?: unknown, detail?: unknown}} payload - probe payload.
 * @returns {Promise<{path: string, line: string}>} what was written.
 */
export async function recordSpike(payload) {
  const surface = typeof payload.surface === 'string' ? payload.surface : 'unknown'
  const detail = typeof payload.detail === 'string' ? payload.detail : ''
  const stamps = payload.stamps === undefined ? '' : ` ${JSON.stringify(payload.stamps)}`
  const line = `${new Date().toISOString()} ${surface}${detail.length > 0 ? ` ${detail}` : ''}${stamps}`
  const target = spikeLogPath()
  await mkdir(path.dirname(target), { recursive: true })
  await appendFile(target, `${line}\n`, 'utf8')
  return { path: target, line }
}

/**
 * Shape one resolved workflow for the canvas.
 * @param {Record<string, any>} resolved - resolver output.
 * @returns {Record<string, any>} canvas payload.
 */
export function shapeCanvas(resolved) {
  return {
    key: resolved.key,
    alias: resolved.alias ?? '',
    assetId: resolved.assetId,
    assetName: resolved.assetName ?? '',
    definition: resolved.definition,
    source: resolved.source,
    revision: resolved.revision ?? null,
    currentRevision: resolved.currentRevision ?? null,
    baseRevision: resolved.baseRevision ?? null,
    drift: resolved.drift === true,
    hash: resolved.hash ?? null,
  }
}

/**
 * The left tree of the page: every workspace with its refs, plus the library.
 *
 * The workspace list comes from the client (it owns `ctx.workspaces.list`), so
 * the host never guesses which directories the user considers workspaces.
 * @param {Record<string, any>} service - plugin service.
 * @param {Record<string, any>} payload - `{workspaces: [{id, name, path}]}`.
 * @returns {Promise<{workspaces: Record<string, any>[], assets: Record<string, any>[]}>} tree payload.
 */
export async function treePayload(service, payload) {
  const requested = Array.isArray(payload.workspaces) ? payload.workspaces : []
  /** @type {Record<string, any>[]} */
  const workspaces = []
  for (const entry of requested) {
    const path = typeof entry?.path === 'string' ? entry.path : ''
    if (path.length === 0) continue
    const id = typeof entry.id === 'string' ? entry.id : null
    const name = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : path
    try {
      workspaces.push({ id, name, path, workflows: await service.listWorkflows(path) })
    } catch (error) {
      workspaces.push({ id, name, path, workflows: [], error: error?.code ?? 'list-failed', message: String(error?.message ?? error) })
    }
  }
  const anchor = workspaces[0]?.path ?? payload.anchor ?? ''
  const assets = anchor.length === 0 ? [] : await service.listAssets(anchor)
  return { workspaces, assets }
}

/**
 * Resolve one workflow for the canvas.
 * @param {Record<string, any>} service - plugin service.
 * @param {Record<string, any>} payload - `{workspace, key}`.
 * @returns {Promise<Record<string, any>>} canvas payload.
 */
export async function canvasPayload(service, payload) {
  const workspace = typeof payload.workspace === 'string' ? payload.workspace : ''
  const key = typeof payload.key === 'string' ? payload.key : ''
  if (workspace.length === 0 || key.length === 0) throw new UiError('ui-args', 'canvas needs {workspace, key}')
  return { workspace, key, ...shapeCanvas(await service.resolve(workspace, key)) }
}

/**
 * Read one library asset for the canvas (no workspace ref involved).
 * @param {Record<string, any>} service - plugin service.
 * @param {Record<string, any>} payload - `{assetId, revision?}`.
 * @returns {Promise<Record<string, any>>} canvas payload.
 */
export async function assetCanvasPayload(service, payload) {
  const assetId = typeof payload.assetId === 'string' ? payload.assetId : ''
  if (assetId.length === 0) throw new UiError('ui-args', 'assetCanvas needs {assetId}')
  const revision = Number.isInteger(payload.revision) ? payload.revision : null
  const record = await service.readAsset(assetId, revision)
  return {
    assetId,
    key: assetId,
    alias: '',
    assetName: String(record.asset?.name ?? ''),
    definition: record.definition,
    source: revision === null ? 'asset' : 'revision',
    revision: revision ?? Number(record.asset?.revision ?? 1),
    currentRevision: Number(record.asset?.revision ?? 1),
    baseRevision: null,
    drift: false,
    hash: record.hash ?? null,
  }
}

/**
 * Wait for the first pending task the caller has not seen yet.
 *
 * Notifications poll through this instead of `monitor`: one long-running
 * command per window writes one `command/run` pair into the session log, where
 * a short poll loop wrote one every five seconds.
 * @param {Record<string, any>} service - plugin service.
 * @param {Record<string, any>} payload - `{known: string[], timeoutMs?: number}`.
 * @returns {Promise<Record<string, any>>} `{changed, runs, tasks}`.
 */
export async function waitPayload(service, payload) {
  const known = new Set(Array.isArray(payload.known) ? payload.known.filter((id) => typeof id === 'string') : [])
  const requested = Number.isFinite(payload.timeoutMs) ? payload.timeoutMs : 25000
  const timeoutMs = Math.min(60000, Math.max(1000, requested))
  const deadline = Date.now() + timeoutMs
  const snapshot = await service.monitor()
  for (;;) {
    if (snapshot.tasks.some((task) => !known.has(task.taskId))) return { changed: true, ...snapshot }
    if (Date.now() >= deadline) return { changed: false, ...snapshot }
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const next = await service.monitor()
    snapshot.runs = next.runs
    snapshot.tasks = next.tasks
  }
}

/**
 * Route one `/workflow ui` call.
 * @param {string[]} tokens - arguments after `ui`.
 * @param {{service?: Record<string, any>}} [options] - plugin wiring.
 * @returns {Promise<string>} JSON text.
 */
export async function dispatchUi(tokens, options = {}) {
  const [op, encoded] = tokens
  if (op === undefined) throw new UiError('ui-op', 'usage: /workflow ui <op> [base64url payload]')
  /** @type {Set<string>} */
  const ops = new Set(['ping', 'tree', 'canvas', 'assetCanvas', 'monitor', 'wait'])
  if (!ops.has(op)) throw new UiError('ui-op', `unknown ui op: ${op}`)
  const payload = decodePayload(encoded)
  if (op === 'ping') {
    const written = await recordSpike(payload)
    return JSON.stringify({ ok: true, op, path: written.path })
  }
  const service = options.service
  if (service === undefined) throw new UiError('ui-service', 'the workflow service is not available for this command')
  if (op === 'tree') return JSON.stringify(await treePayload(service, payload))
  if (op === 'canvas') return JSON.stringify(await canvasPayload(service, payload))
  if (op === 'assetCanvas') return JSON.stringify(await assetCanvasPayload(service, payload))
  if (op === 'wait') return JSON.stringify(await waitPayload(service, payload))
  return JSON.stringify(await service.monitor())
}
