/**
 * Exact Fetch route for the HNFlow model-layer settings page.
 *
 * GET  /api/capability/models  -> {ok, layers, default, warnings, catalog?}
 * POST /api/capability/models  -> validate bindings, atomically write, reload
 *
 * `layers` is the platform catalog annotated with this machine's bindings and
 * DSH-only custom layers. The route never exposes the config path or
 * credentials; the service owns both reads and writes.
 */

import { saveModels } from './service.js'

/** Route path under Connection's `/api` prefix. */
export const MODELS_PATH = '/api/capability/models'

/**
 * Build the exact Fetch route.
 * @param {{service: import('./service.js').CapabilityService}} options - wiring.
 * @returns {{path: string, methods: string[], requestBody: 'buffered', fetch: (request: Request) => Promise<Response>}} route.
 */
export function createModelsRoute(options) {
  const { service } = options
  return {
    path: MODELS_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        if (request.method === 'GET') {
          if (service.catalogReady && typeof service.catalogReady.then === 'function') {
            await service.catalogReady
          }
          const snapshot = await service.reload()
          const catalog = await service.catalog(request.signal)
          return json({ ok: true, ...snapshot, selector: service.modelSelector, catalog })
        }
        let body
        try {
          body = await request.json()
        } catch {
          return json({ ok: false, code: 'invalid-json', message: 'request body must be JSON' }, 400)
        }
        const result = await saveModels(service, body)
        return json(result, result.ok ? 200 : 400)
      } catch (error) {
        return json(
          { ok: false, code: 'models-route-failed', message: String(error?.message ?? error) },
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
