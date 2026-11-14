/**
 * Resolve the directory a session would load its context from.
 *
 * A freshly opened chat window has a session id but no host session yet: the
 * harness only persists a session when it accepts the first prompt, so a
 * read-only surface has to answer before that. The order mirrors the harness:
 *
 * 1. the live agent's own directory,
 * 2. the directory recorded in the session log,
 * 3. a directory the client reports for the window (the workspace the window
 *    belongs to), accepted only when it is an existing absolute path,
 * 4. the workspace the host itself lists as owning the session,
 * 5. the deployment fallback the host itself would use.
 *
 * Every service lookup is defensive: a missing or failing service must not turn
 * a readable preview into a 500.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'

/**
 * Resolve one session's working directory.
 * @param {any} ctx - plugin context.
 * @param {string} sessionId - session id from the client.
 * @param {string} [hint] - absolute directory proposed by the client.
 * @returns {Promise<string | null>} absolute directory, or null when none is known.
 */
export async function resolveSessionCwd(ctx, sessionId, hint) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  const workingDirectory = service(ctx, 'workingDirectory')
  const live = liveDirectory(ctx, workingDirectory, sessionId)
  if (isDirectory(live)) return live
  const recorded = await recordedDirectory(ctx, sessionId)
  if (isDirectory(recorded)) return recorded
  const hinted = existingDirectory(hint)
  if (hinted !== null) return hinted
  const owned = existingDirectory(workspaceDirectoryOf(sessionId))
  if (owned !== null) return owned
  const fallback = property(workingDirectory, 'defaultDirectory')
  return existingDirectory(fallback)
}

/**
 * Find the workspace the host lists as owning a session.
 *
 * A blank session is created through `session.create`, which attaches it to the
 * chosen workspace before the first prompt; the workspace store keeps that
 * membership (`tables.workspaces.<id>.sessionIds`). The store is a private host
 * file, so every read is optional: any failure simply returns undefined and the
 * next fallback takes over.
 * @param {string} sessionId - session id.
 * @returns {string | undefined} workspace path.
 */
export function workspaceDirectoryOf(sessionId) {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  let store
  try {
    store = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8'))
  } catch {
    return undefined
  }
  const workspaces = store?.tables?.workspaces
  if (workspaces === null || typeof workspaces !== 'object') return undefined
  for (const record of Object.values(workspaces)) {
    if (record === null || typeof record !== 'object') continue
    if (!Array.isArray(record.sessionIds) || !record.sessionIds.includes(sessionId)) continue
    if (typeof record.path === 'string' && record.path.length > 0) return record.path
  }
  return undefined
}

/**
 * Report which inputs the plugin could see, for actionable route errors.
 * @param {any} ctx - plugin context.
 * @returns {{workingDirectory: boolean, sessions: boolean, sessionQuery: boolean}} availability.
 */
export function diagnoseSessionCwd(ctx) {
  return {
    workingDirectory: service(ctx, 'workingDirectory') !== undefined,
    sessions: service(ctx, 'sessions') !== undefined,
    sessionQuery: service(ctx, 'sessionQuery') !== undefined,
  }
}

/**
 * Read a service without letting a context failure escape.
 * @param {any} ctx - plugin context.
 * @param {string} name - service name.
 * @returns {any} the service, or undefined.
 */
function service(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/**
 * Read one property of a service without letting a getter fail.
 * @param {any} target - service.
 * @param {string} name - property name.
 * @returns {any} the value, or undefined.
 */
function property(target, name) {
  try {
    return target?.[name]
  } catch {
    return undefined
  }
}

/**
 * Read the live session's directory when the agent already exists.
 * @param {any} ctx - plugin context.
 * @param {any} workingDirectory - working-directory service.
 * @param {string} sessionId - session id.
 * @returns {string | undefined} directory.
 */
function liveDirectory(ctx, workingDirectory, sessionId) {
  const sessions = service(ctx, 'sessions')
  let session
  try {
    session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
  } catch {
    return undefined
  }
  if (session === undefined || session === null) return undefined
  try {
    return workingDirectory?.get?.(session)
  } catch {
    return undefined
  }
}

/**
 * Read the directory recorded by the session log, if the session has one.
 * @param {any} ctx - plugin context.
 * @param {string} sessionId - session id.
 * @returns {Promise<string | undefined>} directory.
 */
async function recordedDirectory(ctx, sessionId) {
  const sessionQuery = service(ctx, 'sessionQuery')
  if (typeof sessionQuery?.observeSession !== 'function') return undefined
  let observation
  try {
    observation = await sessionQuery.observeSession(sessionId)
  } catch {
    return undefined
  }
  try {
    return observation?.projections?.values?.workingDirectory ?? observation?.header?.cwd ?? undefined
  } catch {
    return undefined
  } finally {
    try {
      if (typeof observation?.dispose === 'function') observation.dispose()
    } catch {
      /* ignore */
    }
  }
}

/**
 * Normalize a client hint into an existing absolute directory.
 * @param {unknown} value - candidate.
 * @returns {string | null} absolute directory, or null when unusable.
 */
export function existingDirectory(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  if (!isAbsolute(value)) return null
  try {
    if (!existsSync(value)) return null
    if (!statSync(value).isDirectory()) return null
    return resolvePath(value)
  } catch {
    return null
  }
}

/**
 * Whether a value is a usable directory string.
 * @param {unknown} value - candidate.
 * @returns {boolean} true when non-empty.
 */
function isDirectory(value) {
  return typeof value === 'string' && value.length > 0
}
