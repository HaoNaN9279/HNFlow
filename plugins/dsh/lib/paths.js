/**
 * Filesystem layout shared by the stores.
 *
 * Assets live outside any workspace (the reuse contract); a workspace only
 * holds `.hnflow/workflows.json` refs and `.hnflow/overrides/*.workflow.json`
 * copies. See `docs/dsh-plugin-plan.md` §5.
 */

import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** `plugins/dsh` directory. */
export const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
/** Repository root that contains `plugins/` and `backend/`. */
export const REPO_ROOT = path.resolve(PLUGIN_DIR, '..', '..')

/** File suffix that marks a workflow asset. */
export const ASSET_SUFFIX = '.workflow.json'
/** Override directory name inside the workspace state directory. */
export const OVERRIDES_DIR = 'overrides'
/** Ref manifest file name inside the workspace state directory. */
export const REFS_FILE = 'workflows.json'

/**
 * The DSH home directory.
 * @returns {string} absolute path.
 */
export function dshHome() {
  const explicit = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return explicit.length > 0 ? path.resolve(explicit) : path.join(os.homedir(), '.dsh')
}

/**
 * The asset library root.
 * @param {{libraryRoot?: string}} config - plugin config.
 * @returns {string} absolute path.
 */
export function libraryRoot(config) {
  const explicit = typeof config?.libraryRoot === 'string' ? config.libraryRoot.trim() : ''
  return explicit.length > 0 ? path.resolve(explicit) : path.join(dshHome(), 'hnflow', 'library')
}

/**
 * The workspace state directory (`.hnflow` by default).
 * @param {string} cwd - workspace root.
 * @param {{workspaceDir?: string}} config - plugin config.
 * @returns {string} absolute path.
 */
export function stateDir(cwd, config) {
  const name = typeof config?.workspaceDir === 'string' && config.workspaceDir.length > 0 ? config.workspaceDir : '.hnflow'
  return path.join(path.resolve(cwd), name)
}

/**
 * `refs` manifest path for a workspace.
 * @param {string} cwd - workspace root.
 * @param {{workspaceDir?: string}} config - plugin config.
 * @returns {string} absolute path.
 */
export function refsPath(cwd, config) {
  return path.join(stateDir(cwd, config), REFS_FILE)
}

/**
 * Override directory for a workspace.
 * @param {string} cwd - workspace root.
 * @param {{workspaceDir?: string}} config - plugin config.
 * @returns {string} absolute path.
 */
export function overridesDir(cwd, config) {
  return path.join(stateDir(cwd, config), OVERRIDES_DIR)
}

/**
 * Override file for one asset.
 * @param {string} cwd - workspace root.
 * @param {string} assetId - asset identity.
 * @param {{workspaceDir?: string}} config - plugin config.
 * @returns {string} absolute path.
 */
export function overridePath(cwd, assetId, config) {
  return path.join(overridesDir(cwd, config), `${assetId}${ASSET_SUFFIX}`)
}

/**
 * Candidate interpreters for the engine, most specific first.
 *
 * The plugin is developed inside this repository, so the backend virtualenv is
 * the default; `DSH_HNFLOW_PYTHON` overrides it for other checkouts.
 * @param {{enginePython?: string}} config - plugin config.
 * @returns {string | null} an existing interpreter path, or null when unknown.
 */
export function resolvePython(config) {
  const explicit = typeof config?.enginePython === 'string' ? config.enginePython.trim() : ''
  if (explicit.length > 0) return explicit
  const fromEnv = typeof process.env.DSH_HNFLOW_PYTHON === 'string' ? process.env.DSH_HNFLOW_PYTHON.trim() : ''
  if (fromEnv.length > 0) return fromEnv
  const candidates =
    process.platform === 'win32'
      ? [path.join(REPO_ROOT, 'backend', '.venv', 'Scripts', 'python.exe')]
      : [path.join(REPO_ROOT, 'backend', '.venv', 'bin', 'python')]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Working directory for the engine process.
 * @param {{engineCwd?: string}} config - plugin config.
 * @returns {string} absolute path.
 */
export function engineCwd(config) {
  const explicit = typeof config?.engineCwd === 'string' ? config.engineCwd.trim() : ''
  return explicit.length > 0 ? path.resolve(explicit) : path.join(REPO_ROOT, 'backend')
}
