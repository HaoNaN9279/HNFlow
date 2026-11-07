/**
 * Plugin configuration: defaults and defensive coercion.
 *
 * Every value comes from `cordis.patch.yml` or a user's profile patch, so it is
 * treated as untrusted: unknown keys are ignored and wrong types fall back to
 * the default instead of failing the mode.
 */

/** Plugin version recorded in every lockfile. */
export const PLUGIN_VERSION = '0.5.0'

/**
 * The host's per-activation-tree concurrency cap (`maxActiveSubagents`, 8).
 * A flow may not ask for more parallel nodes than the seam can start.
 */
export const MAX_PARALLEL_CAP = 8

export const DEFAULT_CONFIG = Object.freeze({
  /** `false` turns this row into the client-only UI row. */
  host: true,
  /** `core` owns the service and routes; `preset` owns the session tools; `ui` owns only the bundle. */
  role: 'preset',
  /** Flow asset root; empty means `$DSH_HOME/hnflow/library`. */
  libraryRoot: '',
  /** Workspace-relative directory holding refs and overrides. */
  workspaceDir: '.hnflow',
  /** Degraded file store root; empty means `$DSH_HOME/hnflow/state`. */
  stateDir: '',
  /** Presets a node may name in `preset`. */
  presetAllowlist: ['hnflow', 'standard'],
  /** Nodes advanced concurrently inside one run (never above the host's activation cap). */
  maxParallel: 3,
  /** Default attempt budget for an agent/judge node without `budget.maxAttempts`. */
  maxAttempts: 2,
  /** Default per-node timeout. */
  nodeTimeoutMs: 900000,
  /** Flow names injected into the system prompt. */
  maxIndexEntries: 20,
  /** Use the DSH storage domain when it is mounted; `false` forces the file store. */
  storage: true,
})

/** Keys whose value is a list of strings rather than a scalar. */
const STRING_LISTS = new Set(['presetAllowlist'])
const ROLES = new Set(['core', 'preset', 'ui'])

/**
 * Coerce a raw row config into the plugin's shape.
 * @param {unknown} raw - config object from the composition.
 * @returns {typeof DEFAULT_CONFIG} resolved configuration.
 */
export function resolveConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  /** @type {Record<string, unknown>} */
  const config = { ...DEFAULT_CONFIG, presetAllowlist: [...DEFAULT_CONFIG.presetAllowlist] }
  for (const [key, fallback] of Object.entries(DEFAULT_CONFIG)) {
    const value = source[key]
    if (value === undefined || value === null) continue
    if (STRING_LISTS.has(key)) {
      if (Array.isArray(value)) {
        const list = value.filter((entry) => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim())
        if (list.length > 0) config[key] = list
      }
      continue
    }
    if (typeof fallback === 'boolean') {
      if (typeof value === 'boolean') config[key] = value
      continue
    }
    if (typeof fallback === 'number') {
      if (Number.isFinite(value) && value > 0) config[key] = Math.floor(value)
      continue
    }
    if (typeof value === 'string') {
      if (key === 'role' && !ROLES.has(value)) continue
      config[key] = value.trim()
    }
  }
  if (!ROLES.has(config.role)) config.role = DEFAULT_CONFIG.role
  if (config.maxParallel < 1) config.maxParallel = DEFAULT_CONFIG.maxParallel
  // Never ask the subagent seam for more activations than it can start at once.
  if (config.maxParallel > MAX_PARALLEL_CAP) config.maxParallel = MAX_PARALLEL_CAP
  return config
}
