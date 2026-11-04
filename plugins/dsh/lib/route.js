/**
 * The monitor route: `/api/hnflow/tasks`.
 *
 * The browser half must announce new human tasks without writing anything into
 * a session. Every `remote.commands.execute` appends a `command/run` +
 * `command/done` pair to the session it names, so the notification cannot ride
 * the command channel: an exact Fetch route returns the same monitor payload
 * with no session involved.
 *
 * The payload is read from the engine's state files (`runs.json`,
 * `tasks.json`), exactly like `/hnflow ui monitor`, so this route never starts
 * a second engine and never waits on one.
 */

/** Route path; it must live under Connection's `/api` prefix. */
export const MONITOR_PATH = '/api/hnflow/tasks'

/**
 * Build the exact Fetch route for the monitor payload.
 * @param {{service: import('./service.js').HnflowService}} options - wiring.
 * @returns {{path: string, methods: string[], requestBody: 'buffered', fetch: (request: Request) => Promise<Response>}} route.
 */
export function createMonitorRoute(options) {
  const { service } = options
  return {
    path: MONITOR_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    /**
     * Answer one GET with the current runs and pending tasks.
     * @returns {Promise<Response>} JSON response.
     */
    fetch: async () => {
      try {
        const payload = await service.fileMonitor()
        return json({ ok: true, ...payload })
      } catch (error) {
        return json({ ok: false, error: String(error?.code ?? 'monitor-failed'), message: String(error?.message ?? error) }, 500)
      }
    },
  }
}

/**
 * One JSON response with no caching.
 * @param {unknown} value - JSON-serializable body.
 * @param {number} [status] - HTTP status.
 * @returns {Response} the response.
 */
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
