/**
 * Plugin configuration: defaults and defensive coercion.
 *
 * Every value comes from `cordis.patch.yml` or a user's profile patch, so it is
 * treated as untrusted: unknown keys are ignored and wrong types fall back to
 * the default instead of failing the mode.
 */

export const DEFAULT_CONFIG = Object.freeze({
  /** `false` turns this row into the client-only UI row. */
  host: true,
  /** Workflow asset root; empty means `$DSH_HOME/hnflow/library`. */
  libraryRoot: '',
  /** Workspace-relative directory holding refs and overrides. */
  workspaceDir: '.hnflow',
  /** Python interpreter that runs the engine; empty means auto-discovery. */
  enginePython: '',
  /** Engine entry module, imported with `-m`. */
  engineModule: 'deerflow.workflow.rpc',
  /** Working directory for the engine process; empty means auto-discovery. */
  engineCwd: '',
  /** Engine state directory (checkpoints + run/task records); empty means `$DSH_HOME/hnflow/state`. */
  stateDir: '',
  /** Upper bound for one engine request. */
  requestTimeoutMs: 120000,
  /** Upper bound for the stdio handshake. */
  startupTimeoutMs: 20000,
  /** Number of workflow names injected into the system prompt. */
  maxIndexEntries: 20,
})

/**
 * Coerce a raw row config into the plugin's shape.
 * @param {unknown} raw - config object from the composition.
 * @returns {typeof DEFAULT_CONFIG} resolved configuration.
 */
export function resolveConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  /** @type {Record<string, unknown>} */
  const config = { ...DEFAULT_CONFIG }
  for (const [key, fallback] of Object.entries(DEFAULT_CONFIG)) {
    const value = source[key]
    if (value === undefined || value === null) continue
    if (typeof fallback === 'boolean') {
      if (typeof value === 'boolean') config[key] = value
      continue
    }
    if (typeof fallback === 'number') {
      if (Number.isFinite(value) && value > 0) config[key] = Math.floor(value)
      continue
    }
    if (typeof value === 'string') config[key] = value.trim()
  }
  return config
}
