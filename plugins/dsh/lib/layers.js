/**
 * The VibeStack seam: HNFlow's only source of model routes.
 *
 * HNFlow never reads VibeStack's config, never keeps a model catalog and never
 * talks to a provider. A node names a layer id; `ctx.vibestack` turns it into
 * `{provider, model, reasoningEffort}` at run start, and the lockfile pins the
 * answer. Missing service or a missing layer is fail-loud — falling back to a
 * default route would make a published revision non-reproducible.
 */

/** Minimum VibeStack service contract HNFlow needs. */
export const REQUIRED_API_VERSION = 2

/**
 * Read the VibeStack service from a context.
 * @param {Record<string, any>} ctx - Cordis context.
 * @returns {Record<string, any> | undefined} service, when mounted.
 */
export function vibestackOf(ctx) {
  try {
    return ctx?.get?.('vibestack')
  } catch {
    return undefined
  }
}

/**
 * Whether the service satisfies the contract HNFlow requires.
 * @param {Record<string, any> | undefined} service - VibeStack service.
 * @returns {boolean} true when usable.
 */
export function vibestackAvailable(service) {
  return service !== null && service !== undefined && Number(service.apiVersion) >= REQUIRED_API_VERSION && typeof service.resolveLayer === 'function'
}

/**
 * Resolve one model layer and (when possible) check that it routes.
 * @param {Record<string, any> | undefined} service - VibeStack service.
 * @param {string} id - layer id.
 * @returns {Promise<{ok: true, layer: Record<string, any>} | {ok: false, code: string, message?: string}>} result.
 */
export async function layerStatus(service, id) {
  if (!vibestackAvailable(service)) {
    return { ok: false, code: 'vibestack-unavailable', message: 'VibeStack is not mounted or its apiVersion is below 2' }
  }
  let layer
  try {
    layer = service.resolveLayer(id)
  } catch (error) {
    return { ok: false, code: 'model-layer-unknown', message: String(error?.message ?? error) }
  }
  if (layer === undefined || layer === null) {
    return { ok: false, code: 'model-layer-unknown', message: `no model layer named ${id}` }
  }
  // The catalog check is optional: without an LLM service the layer still
  // resolves, and the spawn is where an unroutable route will surface.
  try {
    if (typeof service.catalog === 'function') {
      const catalog = await service.catalog()
      if (catalog !== null && typeof catalog === 'object' && catalog.error === undefined && Array.isArray(catalog.unroutable)) {
        const unroutable = catalog.unroutable.find((entry) => entry?.id === id)
        if (unroutable !== undefined) {
          return { ok: false, code: 'model-layer-unroutable', message: String(unroutable.reason ?? 'the route is not in the model catalog') }
        }
      }
    }
  } catch {
    // A catalog probe failure is not a layer failure; the layer still exists.
  }
  return { ok: true, layer: { ...layer } }
}

/**
 * Turn a resolved layer into the spawn's `agentOptions`.
 * @param {Record<string, any>} layer - resolved layer.
 * @returns {{provider: string, model: string, reasoningEffort?: string}} spawn options.
 */
export function agentOptionsOf(layer) {
  /** @type {{provider: string, model: string, reasoningEffort?: string}} */
  const options = { provider: String(layer.provider), model: String(layer.model) }
  if (typeof layer.reasoningEffort === 'string' && layer.reasoningEffort.length > 0) options.reasoningEffort = layer.reasoningEffort
  return options
}

/**
 * Snapshot the VibeStack contract for a lockfile.
 * @param {Record<string, any> | undefined} service - service.
 * @returns {{available: boolean, apiVersion: number | null}} snapshot.
 */
export function vibestackSnapshot(service) {
  return {
    available: vibestackAvailable(service),
    apiVersion: service === undefined || service === null ? null : Number(service.apiVersion) || null,
  }
}
