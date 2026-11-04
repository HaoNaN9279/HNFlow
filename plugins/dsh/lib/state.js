/**
 * Monitor data read straight from the engine's state directory.
 *
 * The resident page must work without any HNFlow session, so its viewer row may
 * not start an engine: two engine processes would share `checkpoints.sqlite` and
 * `runs.json`. The engine persists both files on every state change
 * (`RunHost._persist`), which is exactly what a read-only view needs.
 *
 * The shaping is shared with the engine-backed path, so both views agree.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { dshHome } from './paths.js'

/**
 * Where the engine keeps its durable records.
 * @param {{stateDir?: string}} config - plugin config.
 * @returns {string} absolute directory.
 */
export function stateDirectory(config) {
  const explicit = typeof config?.stateDir === 'string' ? config.stateDir.trim() : ''
  return explicit.length > 0 ? path.resolve(explicit) : path.join(dshHome(), 'hnflow', 'state')
}

/**
 * Read one JSON array file, tolerating a missing or half-written file.
 * @param {string} file - absolute path.
 * @returns {Promise<Record<string, any>[]>} rows (empty when unreadable).
 */
async function readRows(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return []
  }
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.filter((row) => row !== null && typeof row === 'object') : []
  } catch {
    return []
  }
}

/**
 * Read the durable runs and tasks.
 * @param {{stateDir?: string}} config - plugin config.
 * @returns {Promise<{runs: Record<string, any>[], tasks: Record<string, any>[]}>} raw records.
 */
export async function readState(config) {
  const directory = stateDirectory(config)
  const [runs, tasks] = await Promise.all([readRows(path.join(directory, 'runs.json')), readRows(path.join(directory, 'tasks.json'))])
  return { runs, tasks }
}

/**
 * The last node a run touched, whichever shape the record has.
 * @param {Record<string, any>} run - engine or file record.
 * @returns {string | null} node id.
 */
function lastNode(run) {
  const nodes = run?.nodes
  if (Array.isArray(nodes)) return nodes.length > 0 ? (nodes.at(-1)?.nodeId ?? null) : null
  if (nodes !== null && typeof nodes === 'object') {
    const ids = Object.keys(nodes)
    return ids.length > 0 ? ids.at(-1) : null
  }
  return null
}

/**
 * Turn raw records into the payload the page and the right panel render.
 *
 * Accepts both producers: `run/list` + `task/list` (camelCase wire shape) and
 * `runs.json` + `tasks.json` (the store's snake_case rows).
 * @param {Record<string, any>[]} runs - raw run records.
 * @param {Record<string, any>[]} tasks - raw task rows.
 * @returns {{runs: Record<string, any>[], tasks: Record<string, any>[]}} monitor payload.
 */
export function shapeMonitor(runs, tasks) {
  const runRows = Array.isArray(runs) ? runs.filter((run) => run !== null && typeof run === 'object') : []
  const taskRows = Array.isArray(tasks) ? tasks.filter((task) => task !== null && typeof task === 'object') : []
  /** @type {Map<string, Record<string, any>>} */
  const byRun = new Map(runRows.map((run) => [String(run.runId ?? run.id ?? ''), run]))
  const shapedRuns = runRows.map((run) => {
    const metadata = run.metadata ?? {}
    return {
      runId: run.runId ?? run.id ?? '',
      status: String(run.status ?? 'unknown'),
      startedAt: run.startedAt ?? run.started_at ?? null,
      endedAt: run.endedAt ?? run.ended_at ?? null,
      updatedAt: run.updatedAt ?? run.endedAt ?? run.ended_at ?? run.startedAt ?? run.started_at ?? null,
      workspace: metadata.workspace ?? null,
      sessionId: metadata.sessionId ?? null,
      workflow: metadata.workflowAlias || metadata.workflowAssetId || null,
      assetId: metadata.workflowAssetId ?? null,
      error: run.error ?? null,
      node: lastNode(run),
    }
  })
  const shapedTasks = taskRows
    .filter((task) => String(task.status ?? 'pending') === 'pending')
    .map((task) => {
      const runId = String(task.runId ?? task.workflow_run_id ?? '')
      const run = byRun.get(runId) ?? null
      const metadata = run?.metadata ?? {}
      return {
        taskId: String(task.taskId ?? task.id ?? ''),
        runId,
        nodeId: String(task.nodeId ?? task.node_id ?? ''),
        kind: String(task.kind ?? 'task'),
        description: String(task.description ?? ''),
        createdAt: task.createdAt ?? task.created_at ?? null,
        updatedAt: task.updatedAt ?? task.updated_at ?? null,
        workspace: metadata.workspace ?? null,
        sessionId: metadata.sessionId ?? null,
        workflow: metadata.workflowAlias || metadata.workflowAssetId || null,
      }
    })
    .filter((task) => task.taskId.length > 0)
  return { runs: shapedRuns, tasks: shapedTasks }
}

/**
 * The monitor payload read from disk.
 * @param {{stateDir?: string}} config - plugin config.
 * @returns {Promise<{runs: Record<string, any>[], tasks: Record<string, any>[]}>} monitor payload.
 */
export async function fileMonitor(config) {
  const { runs, tasks } = await readState(config)
  return shapeMonitor(runs, tasks)
}
