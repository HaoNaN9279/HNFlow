/**
 * Fetch routes for the workspace capability-group switcher window.
 *
 * GET  /api/capability/groups?workspace=<dir>
 *   -> {ok: true, catalog: {repo, project, groups: [...]}}
 *
 * POST /api/capability/groups/select  {workspace, group, active}
 *   -> {ok: true, catalog: {...}} (rewritten `.hnflow/stack.json`)
 *
 * GET  /api/capability/groups/text?workspace=<dir>&path=<file>
 *   -> {ok: true, text, truncated, path}
 *
 * The list route is the only source of truth the client sees: it names every
 * group with its activation state and every content file with a path. The text
 * route accepts one of those paths only, so it never becomes a file reader.
 * Writes go through `hnflow-stack activate|deactivate`; the plan cache notices
 * the stack file change on the next step, so no session restart is needed.
 */

import { readFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'

import { findContent, loadGroups, selectGroup } from './groups.js'
import { repoFor } from './resolve.js'

/** Group list route path. */
export const GROUPS_PATH = '/api/capability/groups'
/** Activation write route path. */
export const GROUPS_SELECT_PATH = '/api/capability/groups/select'
/** Content preview route path. */
export const GROUPS_TEXT_PATH = '/api/capability/groups/text'

/**
 * Build the three routes.
 * @param {{config: Record<string, any>, execute?: Function, readFile?: (file: string) => Promise<string>, textBytes?: number}} options - wiring.
 * @returns {Array<{path: string, methods: string[], requestBody: 'buffered', fetch: (request: Request) => Promise<Response>}>} routes.
 */
export function createGroupsRoutes(options) {
  const config = options.config ?? {}
  const execute = options.execute
  const readText = options.readFile ?? ((file) => readFile(file, 'utf8'))
  const textBytes = Number.isFinite(options.textBytes) && options.textBytes > 0
    ? options.textBytes
    : 65536

  const catalogFor = (workspace) =>
    loadGroups({ project: workspace, repo: repoFor(workspace), command: config.command, timeoutMs: config.timeoutMs, execute })

  const listRoute = {
    path: GROUPS_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = new URL(request.url)
        const workspace = workspaceOf(url.searchParams.get('workspace'))
        if (workspace === null) return badWorkspace()
        return json({ ok: true, catalog: await catalogFor(workspace) })
      } catch (error) {
        return failure(error)
      }
    },
  }

  const selectRoute = {
    path: GROUPS_SELECT_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        let body
        try {
          body = await request.json()
        } catch {
          return json({ ok: false, code: 'invalid-json', message: 'the request body must be JSON' }, 400)
        }
        const workspace = workspaceOf(body?.workspace)
        if (workspace === null) return badWorkspace()
        const group = typeof body?.group === 'string' ? body.group.trim() : ''
        if (group.length === 0) return json({ ok: false, code: 'group-required', message: 'group is required' }, 400)
        if (typeof body?.active !== 'boolean') {
          return json({ ok: false, code: 'active-required', message: 'active must be a boolean' }, 400)
        }
        await selectGroup({
          project: workspace,
          repo: repoFor(workspace),
          group,
          active: body.active,
          command: config.command,
          timeoutMs: config.timeoutMs,
          execute,
        })
        return json({ ok: true, catalog: await catalogFor(workspace) })
      } catch (error) {
        return failure(error)
      }
    },
  }

  const textRoute = {
    path: GROUPS_TEXT_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = new URL(request.url)
        const workspace = workspaceOf(url.searchParams.get('workspace'))
        if (workspace === null) return badWorkspace()
        const target = url.searchParams.get('path') ?? ''
        const catalog = await catalogFor(workspace)
        const found = findContent(catalog, target)
        if (!found.ok) return json({ ok: false, code: 'unknown-entry', message: found.reason }, 404)
        const text = await readText(found.item.path)
        const encoded = Buffer.from(text, 'utf8')
        const truncated = encoded.length > textBytes
        return json({
          ok: true,
          text: truncated ? encoded.subarray(0, textBytes).toString('utf8') : text,
          truncated,
          path: found.item.path,
          group: found.group?.name ?? '',
          kind: found.item.kind ?? '',
          name: found.item.name ?? '',
        })
      } catch (error) {
        return failure(error)
      }
    },
  }

  return [listRoute, selectRoute, textRoute]
}

/**
 * Normalise the `workspace` parameter to an existing absolute directory.
 * @param {unknown} value - raw query/body value.
 * @returns {string | null} absolute directory, or null.
 */
export function workspaceOf(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const resolved = path.resolve(value)
  try {
    return path.isAbsolute(value) && existsSync(resolved) && statSync(resolved).isDirectory() ? resolved : null
  } catch {
    return null
  }
}

/**
 * Response for a missing or unknown workspace.
 * @returns {Response} 400.
 */
function badWorkspace() {
  return json({ ok: false, code: 'workspace-required', message: 'workspace must be an existing absolute directory' }, 400)
}

/**
 * JSON error response built from a thrown value.
 * @param {unknown} error - failure.
 * @returns {Response} 500 (or the error's own status).
 */
function failure(error) {
  return json(
    {
      ok: false,
      code: typeof error?.code === 'string' ? error.code : 'groups-route-failed',
      message: String(error?.message ?? error),
    },
    Number.isInteger(error?.status) ? error.status : 500,
  )
}

/**
 * JSON response with no caching.
 * @param {unknown} value - body.
 * @param {number} [status] - status code.
 * @returns {Response} response.
 */
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
