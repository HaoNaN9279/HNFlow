/**
 * The VibeStack seam: HNFlow's only source of model routes.
 *
 * HNFlow never reads VibeStack's config, never keeps a model catalog and never
 * talks to a provider. A node names a layer id; `ctx.vibestack` turns it into
 * `{provider, model, reasoningEffort}` at run start, and the lockfile pins the
 * answer. Missing service or a missing layer is fail-loud — falling back to a
 * default route would make a published revision non-reproducible.
 *
 * apiVersion 3 is where the catalog distinguishes bound routes from catalog-only
 * layers (`hasLayer`) and marks DSH-only custom layers (`custom: true`); both
 * facts decide whether a flow may pin a layer at all.
 */

/** Minimum VibeStack service contract HNFlow needs. */
export const REQUIRED_API_VERSION = 3

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
  return service !== null
    && service !== undefined
    && Number(service.apiVersion) >= REQUIRED_API_VERSION
    && typeof service.resolveLayer === 'function'
    && typeof service.hasLayer === 'function'
}

/**
 * Resolve one model layer and (when possible) check that it routes.
 *
 * Three failures are distinct on purpose: a typo'd id, a platform layer this
 * machine never bound a route for, and a DSH-only custom layer (usable in a
 * session, never portable inside a flow).
 * @param {Record<string, any> | undefined} service - VibeStack service.
 * @param {string} id - layer id.
 * @returns {Promise<{ok: true, layer: Record<string, any>} | {ok: false, code: string, message?: string}>} result.
 */
export async function layerStatus(service, id) {
  if (!vibestackAvailable(service)) {
    return { ok: false, code: 'vibestack-unavailable', message: `VibeStack is not mounted or its apiVersion is below ${REQUIRED_API_VERSION}` }
  }
  let layer
  try {
    layer = service.resolveLayer(id)
  } catch (error) {
    return { ok: false, code: 'model-layer-unknown', message: String(error?.message ?? error) }
  }
  if (layer === undefined || layer === null) {
    if (knownLayer(service, id)) {
      return {
        ok: false,
        code: 'model-layer-unbound',
        message: `model layer ${id} exists but has no route on this machine; bind it in .vibestack/models.json under bindings.dsh.${id}`,
      }
    }
    return { ok: false, code: 'model-layer-unknown', message: `no model layer named ${id}` }
  }
  if (layer.custom === true) {
    return {
      ok: false,
      code: 'model-layer-custom',
      message: `model layer ${id} is a DSH-only custom layer; flows may only pin platform layers (fast, standard, strong, vision)`,
    }
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
 * Whether the catalog knows the id at all, bound or not.
 * @param {Record<string, any>} service - VibeStack service.
 * @param {string} id - layer id.
 * @returns {boolean} true when the platform or a custom layer defines it.
 */
function knownLayer(service, id) {
  try {
    return service.hasLayer(id) === true
  } catch {
    return false
  }
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

/**
 * VibeStack load warnings (legacy models files, unbound layers, …).
 * Diagnostics only: they never block a publish.
 * @param {Record<string, any> | undefined} service - service.
 * @returns {string[]} warnings.
 */
export function vibestackWarnings(service) {
  try {
    const rows = service?.listWarnings?.()
    return Array.isArray(rows) ? rows.map((row) => String(row)) : []
  } catch {
    return []
  }
}
