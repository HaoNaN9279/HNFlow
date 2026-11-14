/**
 * Plugin configuration: defaults and defensive coercion.
 *
 * The row config comes from `cordis.patch.yml` or a user's profile patch, so
 * every value is treated as untrusted and unknown keys are ignored instead of
 * failing the mode.
 */

export const DEFAULT_CONFIG = Object.freeze({
  /** Row role: `core` (service/routes), `preset` (session mode), or `ui`. */
  role: 'preset',
  /** `false` turns this row into the client-only UI row. */
  host: true,
  /** Optional bindings file; empty uses the global Capability config. */
  modelsFile: '',
  /** `replace` shadows the model seat; `additive` keeps it and adds a layer control. */
  modelSelector: 'replace',
  /** Apply the layer declared by the selected Agent persona. */
  applyModelOnAgent: true,
  /** Apply the layer declared by a capability-group command. */
  applyModelOnCommand: true,
  /** Apply the layer declared by a skill invoked with `/name`. */
  applyModelOnSkill: true,
  /** Apply `models.default` once to a fresh Capability session. */
  applyDefaultLayer: true,
  /** Explicit `hnflow-stack` executable. Empty means auto-discovery. */
  command: '',
  /** Resolve CLI timeout in milliseconds. */
  timeoutMs: 5000,
  /** Resolve mode: `capabilities` keeps Core loaded in every workspace. */
  resolveMode: 'capabilities',
  /** Create `.hnflow/stack.json` when a workspace has none (capability mode only). */
  autoActivate: true,
  /** Namespace prefix for capability-group commands and skills. */
  namePrefix: 'capability',
  /** Maximum published command/skill name length before hashing. */
  maxCommandNameLength: 48,
  /** Skill candidate rank. */
  skillRank: 250,
  /** Inject capability-group rules as workspace instructions. */
  rules: true,
  /** Expose capability-group skills to the agent. */
  skills: true,
  /** Register capability-group commands (and `/capability-agent`). */
  commands: true,
  /** Surface capability-group agents in the session picker. */
  agents: true,
  /** Mount capability-group MCP servers for this agent. */
  mcp: true,
  /** Upper bound for the rendered rules message. */
  maxRulesBytes: 65536,
  /** Expose the session inventory route and the content panel button. */
  inventory: true,
  /** Upper bound for one inventory preview payload. */
  inventoryTextBytes: 65536,
  /** Preferred default agent name; empty falls back to `Athena`. */
  defaultAgent: '',
})

const RESOLVE_MODES = new Set(['project', 'capabilities'])
const ROLES = new Set(['core', 'preset', 'ui'])
const MODEL_SELECTORS = new Set(['additive', 'replace'])

/**
 * Coerce a raw row config into the plugin's config shape.
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
    if (typeof value === 'string') {
      if (key === 'resolveMode') {
        if (RESOLVE_MODES.has(value)) config[key] = value
        continue
      }
      if (key === 'role') {
        if (ROLES.has(value)) config[key] = value
        continue
      }
      if (key === 'modelSelector') {
        if (MODEL_SELECTORS.has(value)) config[key] = value
        continue
      }
      config[key] = value
    }
  }
  if (config.namePrefix.length === 0) config.namePrefix = DEFAULT_CONFIG.namePrefix
  if (config.maxCommandNameLength < 8) {
    config.maxCommandNameLength = DEFAULT_CONFIG.maxCommandNameLength
  }
  return config
}
