/**
 * Exact Fetch routes for the HNFlow surfaces.
 *
 * The page reads and writes only through these routes: no session, no command,
 * no `command/run` event. Every write is explicit about its run and revision,
 * and the service — not the route — owns compare-and-set and persistence.
 */

/** Route paths registered on the Connection fetch registry. */
export const ROUTES = Object.freeze({
  state: '/api/hnflow/state',
  flow: '/api/hnflow/flow',
  inbox: '/api/hnflow/inbox',
  run: '/api/hnflow/run',
  gate: '/api/hnflow/gate',
  deliverable: '/api/hnflow/deliverable',
  start: '/api/hnflow/start',
  publish: '/api/hnflow/publish',
  preview: '/api/hnflow/preview',
  history: '/api/hnflow/history',
  pin: '/api/hnflow/pin',
  add: '/api/hnflow/add',
  rollback: '/api/hnflow/rollback',
  artifact: '/api/hnflow/artifact',
  cancel: '/api/hnflow/cancel',
  resume: '/api/hnflow/resume',
})

/**
 * Build the route list.
 * @param {{service: Record<string, any>}} options - wiring.
 * @returns {Record<string, any>[]} route definitions for `connection.fetch.register`.
 */
export function createRoutes(options) {
  const { service } = options

  /**
   * Read one run's full record.
   * @param {Request} request - incoming request.
   * @returns {Promise<Response>} response.
   */
  const runRoute = {
    path: ROUTES.run,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const runId = new URL(request.url).searchParams.get('runId') ?? ''
        if (runId.length === 0) return json({ ok: false, code: 'run-id-required', message: 'runId is required' }, 400)
        return json({ ok: true, run: await service.getRun(runId) })
      } catch (error) {
        return failure(error)
      }
    },
  }

  /**
   * Read the page snapshot.
   * @param {Request} request - incoming request.
   * @returns {Promise<Response>} response.
   */
  const stateRoute = {
    path: ROUTES.state,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = new URL(request.url)
        const paths = url.searchParams.getAll('workspace')
        const workspaces = paths
          .filter((path) => typeof path === 'string' && path.length > 0)
          .map((path) => ({ id: path, path, name: path.split(/[\\/]/u).filter((part) => part.length > 0).slice(-1)[0] ?? path }))
        return json(await service.snapshot(workspaces))
      } catch (error) {
        return failure(error)
      }
    },
  }

  /**
   * Read the inbox alone (the notice polls this).
   * @returns {Promise<Response>} response.
   */
  const inboxRoute = {
    path: ROUTES.inbox,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      try {
        return json({ ok: true, items: await service.inbox() })
      } catch (error) {
        return failure(error)
      }
    },
  }

  /**
   * Read one resolved flow (the page draws its canvas).
   * @param {Request} request - incoming request.
   * @returns {Promise<Response>} response.
   */
  const flowRoute = {
    path: ROUTES.flow,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = new URL(request.url)
        const workspace = url.searchParams.get('workspace') ?? ''
        const key = url.searchParams.get('flow') ?? ''
        if (workspace.length === 0) return json({ ok: false, code: 'field-required', message: 'workspace is required' }, 400)
        if (key.length === 0) return json({ ok: false, code: 'field-required', message: 'flow is required' }, 400)
        const resolved = await service.describeFlow(workspace, key)
        return json({ ok: true, flow: { ...resolved, workspace } })
      } catch (error) {
        return failure(error)
      }
    },
  }

  /**
   * Read a flow's revision history.
   * @param {Request} request - incoming request.
   * @returns {Promise<Response>} response.
   */
  const historyRoute = {
    path: ROUTES.history,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = new URL(request.url)
        const workspace = url.searchParams.get('workspace') ?? ''
        const flow = url.searchParams.get('flow') ?? ''
        if (workspace.length === 0 || flow.length === 0) return json({ ok: false, code: 'field-required', message: 'workspace and flow are required' }, 400)
        return json({ ok: true, history: await service.history(workspace, flow) })
      } catch (error) {
        return failure(error)
      }
    },
  }

  /**
   * Preview a publish (validation + diff), without creating a revision.
   * @param {Request} request - incoming request.
   * @returns {Promise<Response>} response.
   */
  const previewRoute = {
    path: ROUTES.preview,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = new URL(request.url)
        const workspace = url.searchParams.get('workspace') ?? ''
        const flow = url.searchParams.get('flow') ?? ''
        if (workspace.length === 0 || flow.length === 0) return json({ ok: false, code: 'field-required', message: 'workspace and flow are required' }, 400)
        return json({ ok: true, preview: await service.previewPublish(workspace, flow) })
      } catch (error) {
        return failure(error)
      }
    },
  }

  /**
   * Read one artifact by id.
   * @param {Request} request - incoming request.
   * @returns {Promise<Response>} response.
   */
  const artifactRoute = {
    path: ROUTES.artifact,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const artifactId = new URL(request.url).searchParams.get('artifactId') ?? ''
        if (artifactId.length === 0) return json({ ok: false, code: 'artifact-id-required', message: 'artifactId is required' }, 400)
        return json({ ok: true, artifact: await service.getArtifact(artifactId) })
      } catch (error) {
        return failure(error)
      }
    },
  }

  return [
    stateRoute,
    runRoute,
    flowRoute,
    inboxRoute,
    artifactRoute,
    historyRoute,
    previewRoute,
    post(ROUTES.gate, async (body) => service.decide({ runId: required(body, 'runId'), gateId: required(body, 'gateId'), decision: required(body, 'decision'), reason: optional(body, 'reason'), revision: Number.isInteger(body?.revision) ? body.revision : undefined, artifact: body?.artifact })),
    post(ROUTES.deliverable, async (body) => service.deliver({ runId: required(body, 'runId'), requestId: required(body, 'requestId'), payload: body?.payload, revision: Number.isInteger(body?.revision) ? body.revision : undefined })),
    post(ROUTES.start, async (body) => service.run({ cwd: required(body, 'workspace'), key: required(body, 'flow'), input: body?.input ?? {} })),
    post(ROUTES.publish, async (body) => service.publish({ cwd: required(body, 'workspace'), key: required(body, 'flow'), note: optional(body, 'note') ?? 'published from the HNFlow page' })),
    post(ROUTES.pin, async (body) => service.pinRef(required(body, 'workspace'), required(body, 'flow'), body?.revision === undefined ? 'latest' : body.revision)),
    post(ROUTES.add, async (body) => service.addRef(required(body, 'workspace'), required(body, 'flowId'), optional(body, 'alias'))),
    post(ROUTES.rollback, async (body) => service.rollback({ cwd: required(body, 'workspace'), key: required(body, 'flow'), revision: Number(body?.revision), note: optional(body, 'note') })),
    post(ROUTES.cancel, async (body) => service.cancel(required(body, 'runId'))),
    post(ROUTES.resume, async (body) => service.resume(required(body, 'runId'))),
  ]
}

/**
 * Build a buffered POST route.
 * @param {string} path - route path.
 * @param {(body: Record<string, any>) => Promise<any>} handle - body handler.
 * @returns {Record<string, any>} route definition.
 */
function post(path, handle) {
  return {
    path,
    methods: ['POST'],
    requestBody: 'buffered',
    /**
     * @param {Request} request - incoming request.
     * @returns {Promise<Response>} response.
     */
    fetch: async (request) => {
      try {
        let body
        try {
          body = await request.json()
        } catch {
          return json({ ok: false, code: 'invalid-json', message: 'the request body must be JSON' }, 400)
        }
        const result = await handle(body ?? {})
        // The settled promise is deliberately not awaited: the page gets the
        // run id and follows the run through its snapshot.
        const { settled, ...rest } = result ?? {}
        void settled
        return json({ ok: true, ...rest })
      } catch (error) {
        return failure(error)
      }
    },
  }
}

/**
 * Require a non-empty string field.
 * @param {Record<string, any>} body - request body.
 * @param {string} name - field name.
 * @returns {string} value.
 * @throws {Error} `field-required`.
 */
function required(body, name) {
  const value = body?.[name]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw Object.assign(new Error(`${name} is required`), { code: 'field-required' })
  }
  return value
}

/**
 * Read an optional string field.
 * @param {Record<string, any>} body - request body.
 * @param {string} name - field name.
 * @returns {string | undefined} value.
 */
function optional(body, name) {
  return typeof body?.[name] === 'string' ? body[name] : undefined
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
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Translate a service failure into a JSON response.
 * @param {unknown} error - thrown value.
 * @returns {Response} response.
 */
function failure(error) {
  const code = /** @type {any} */ (error)?.code
  const badRequest = typeof code === 'string' && ['invalid-json', 'field-required', 'input-invalid', 'definition-invalid', 'flow-invalid', 'payload-invalid', 'delivery-rejected', 'delivery-empty', 'invalid-decision', 'reason-required', 'vibestack-unavailable'].includes(code)
  const conflict = typeof code === 'string' && ['stale-revision', 'already-decided', 'run-terminal'].includes(code)
  const status = badRequest ? 400 : conflict ? 409 : typeof code === 'string' && code.endsWith('-missing') ? 404 : 500
  return json(
    {
      ok: false,
      code: typeof code === 'string' ? code : 'internal',
      message: String(error?.message ?? error),
      ...(error?.data === undefined ? {} : { data: error.data }),
    },
    status,
  )
}
