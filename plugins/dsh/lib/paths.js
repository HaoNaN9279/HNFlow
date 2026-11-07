/**
 * Filesystem layout shared by the stores.
 *
 * Assets live outside any workspace (the reuse contract); a workspace only
 * holds `.hnflow/flows.json` refs and `.hnflow/overrides/*.flow.json` copies.
 */

import os from 'node:os'
import path from 'node:path'

/** File suffix that marks a flow asset. */
export const ASSET_SUFFIX = '.flow.json'
/** Override directory name inside the workspace state directory. */
export const OVERRIDES_DIR = 'overrides'
/** Ref manifest file name inside the workspace state directory. */
export const REFS_FILE = 'flows.json'
/** Immutable revision snapshots, relative to the library root. */
export const REVISIONS_DIR = '.hnflow-revisions'

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
 * The degraded file-store root.
 * @param {{stateDir?: string}} config - plugin config.
 * @returns {string} absolute path.
 */
export function stateDirectory(config) {
  const explicit = typeof config?.stateDir === 'string' ? config.stateDir.trim() : ''
  return explicit.length > 0 ? path.resolve(explicit) : path.join(dshHome(), 'hnflow', 'state')
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
 * Override file for one flow.
 * @param {string} cwd - workspace root.
 * @param {string} flowId - flow identity.
 * @param {{workspaceDir?: string}} config - plugin config.
 * @returns {string} absolute path.
 */
export function overridePath(cwd, flowId, config) {
  return path.join(overridesDir(cwd, config), `${flowId}${ASSET_SUFFIX}`)
}

/**
 * Immutable snapshot directory for one flow inside the library.
 * @param {string} root - library root.
 * @param {string} flowId - flow identity.
 * @returns {string} absolute path.
 */
export function revisionsDir(root, flowId) {
  return path.join(root, REVISIONS_DIR, flowId)
}
