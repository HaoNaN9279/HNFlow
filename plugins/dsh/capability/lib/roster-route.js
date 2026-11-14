/**
 * Read-only Fetch route for the pre-turn Agent roster.
 *
 * GET /api/capability/roster?sessionId=<id>&cwd=<workspace>
 *   -> {ok: true, roster: {...} | null}
 *
 * A blank session cannot carry a surface event before the harness appends its
 * first `system/message`, so the composer cannot read the roster from a stored
 * message yet. This route resolves the session's current plan without writing
 * to the session log; `agent/pre-step` remains the only durable publisher.
 */

/** Route path under Connection's `/api` prefix. */
export const ROSTER_PATH = '/api/capability/roster'

/**
 * Build the exact Fetch route.
 * @param {{rosterForSession: (sessionId: string, hint?: string) => Promise<object | null>}} options - wiring.
 * @returns {{path: string, methods: string[], requestBody: 'buffered', fetch: (request: Request) => Promise<Response>}} route.
 */
export function createRosterRoute(options) {
  const { rosterForSession } = options
  return {
    path: ROSTER_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = new URL(request.url)
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (sessionId.length === 0) {
          return json({ ok: false, code: 'missing-session', message: 'sessionId is required' }, 400)
        }
        const hint = url.searchParams.get('cwd') ?? ''
        const roster = await rosterForSession(sessionId, hint.length > 0 ? hint : undefined)
        return json({ ok: true, roster: roster ?? null })
      } catch (error) {
        return json(
          { ok: false, code: 'roster-route-failed', message: String(error?.message ?? error) },
          500,
        )
      }
    },
  }
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
