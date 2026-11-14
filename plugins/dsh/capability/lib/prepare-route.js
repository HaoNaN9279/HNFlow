/**
 * Fetch route that makes a window's workspace ready for the HNFlow mode.
 *
 * GET /api/capability/prepare?sessionId=<id>&cwd=<workspace>
 *   -> {ok: true, ready: true, project, cwd, created, warnings}
 *   -> {ok: true, ready: false, cwd, reason, warnings}
 *
 * Selecting the mode must not leave the composer and the preview waiting for a
 * plan. This route creates `<workspace>/.hnflow/stack.json` when the mode is
 * allowed to, resolves the plan once and leaves it in the shared cache, so the
 * Agent roster, the model layers and the inventory all read a warm plan.
 */

/** Route path under Connection's `/api` prefix. */
export const PREPARE_PATH = '/api/capability/prepare'

/**
 * Build the exact Fetch route.
 * @param {{prepareForSession: (sessionId: string, hint?: string) => Promise<object>}} options - wiring.
 * @returns {{path: string, methods: string[], requestBody: 'buffered', fetch: (request: Request) => Promise<Response>}} route.
 */
export function createPrepareRoute(options) {
  const { prepareForSession } = options
  return {
    path: PREPARE_PATH,
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
        const prepared = await prepareForSession(sessionId, hint.length > 0 ? hint : undefined)
        return json({ ok: true, ...prepared })
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 500
        return json(
          {
            ok: false,
            code: error?.code ?? 'prepare-route-failed',
            message: String(error?.message ?? error),
            details: error?.details ?? undefined,
          },
          status,
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
