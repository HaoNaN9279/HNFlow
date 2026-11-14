/**
 * Read-only Fetch routes for the session inventory panel.
 *
 * GET /api/capability/inventory?sessionId=<id>[&agent=<name>][&cwd=<dir>]
 *   -> {ok: true, inventory: {...}}
 *
 * GET /api/capability/inventory/text?sessionId=<id>&kind=<kind>&id=<id>[&cwd=<dir>]
 *   -> {ok: true, text: string, truncated: boolean, path: string}
 *
 * Both routes resolve the session's existing plan through the shared cache; they
 * never write to the session log. The working directory is the session's own: a
 * window whose host session does not exist yet may pass the workspace it belongs
 * to as `cwd`, and the resolver accepts it only when it names an existing
 * absolute directory. The text route is not a file reader: it looks the entry up
 * in the plan by id, so a caller cannot probe arbitrary paths.
 */

import { buildInventory, inventoryText } from './inventory.js'

/** Inventory list route path under Connection's `/api` prefix. */
export const INVENTORY_PATH = '/api/capability/inventory'
/** Inventory text route path under Connection's `/api` prefix. */
export const INVENTORY_TEXT_PATH = '/api/capability/inventory/text'

/**
 * Build both Fetch routes.
 * @param {{sessionFor: (sessionId: string, hint?: string) => Promise<{plan: object, cwd: string}>, maxRulesBytes?: number, textBytes?: number, home?: string, read?: (file: string) => Promise<string>}} options - wiring.
 * @returns {Array<{path: string, methods: string[], requestBody: 'buffered', fetch: (request: Request) => Promise<Response>}>} routes.
 */
export function createInventoryRoutes(options) {
  const { sessionFor } = options
  const maxRulesBytes = options.maxRulesBytes
  const textBytes = Number.isFinite(options.textBytes) && options.textBytes > 0
    ? options.textBytes
    : 65536
  const read = options.read
  const home = options.home

  const withSession = async (url) => {
    const sessionId = url.searchParams.get('sessionId') ?? ''
    if (sessionId.length === 0) {
      return { error: json({ ok: false, code: 'missing-session', message: 'sessionId is required' }, 400) }
    }
    const hint = url.searchParams.get('cwd') ?? ''
    let resolved
    try {
      resolved = await sessionFor(sessionId, hint)
    } catch (failure) {
      return {
        error: json(
          {
            ok: false,
            code: typeof failure?.code === 'string' ? failure.code : 'inventory-route-failed',
            message: String(failure?.message ?? failure),
            ...(failure?.details === undefined ? {} : { details: failure.details }),
          },
          Number.isInteger(failure?.status) ? failure.status : 500,
        ),
      }
    }
    if (!resolved) {
      return { error: json({ ok: false, code: 'missing-session', message: 'session not found' }, 404) }
    }
    return { plan: resolved.plan, cwd: resolved.cwd ?? '' }
  }

  const listRoute = {
    path: INVENTORY_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = new URL(request.url)
        const resolved = await withSession(url)
        if (resolved.error) return resolved.error
        const inventory = await buildInventory({
          plan: resolved.plan,
          cwd: resolved.cwd,
          agent: url.searchParams.get('agent') ?? '',
          maxRulesBytes,
          home,
          read,
        })
        return json({ ok: true, inventory })
      } catch (error) {
        return json(
          { ok: false, code: 'inventory-route-failed', message: String(error?.message ?? error) },
          500,
        )
      }
    },
  }

  const textRoute = {
    path: INVENTORY_TEXT_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = new URL(request.url)
        const kind = url.searchParams.get('kind') ?? ''
        const id = url.searchParams.get('id') ?? ''
        if (kind.length === 0 || id.length === 0) {
          return json({ ok: false, code: 'missing-entry', message: 'kind and id are required' }, 400)
        }
        const resolved = await withSession(url)
        if (resolved.error) return resolved.error
        const found = await inventoryText({
          plan: resolved.plan,
          cwd: resolved.cwd,
          kind,
          id,
          home,
          read,
        })
        if (!found) {
          return json({ ok: false, code: 'unknown-entry', message: `unknown ${kind}: ${id}` }, 404)
        }
        const encoded = Buffer.from(found.text ?? '', 'utf8')
        const truncated = encoded.length > textBytes
        const text = truncated
          ? encoded.subarray(0, textBytes).toString('utf8')
          : String(found.text ?? '')
        return json({ ok: true, text, truncated, path: found.path ?? '' })
      } catch (error) {
        return json(
          { ok: false, code: 'inventory-text-failed', message: String(error?.message ?? error) },
          500,
        )
      }
    },
  }

  return [listRoute, textRoute]
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
