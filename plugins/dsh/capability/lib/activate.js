/**
 * Auto-initialise Capability for a workspace.
 *
 * Switching a new session to the HNFlow mode should not require the user to
 * run `hnflow-stack init` first. Every plan resolution therefore ensures
 * `.hnflow/stack.json` exists: the file is created through the CLI so the
 * global config keeps pointing at the repository, and a failure degrades to a
 * warning (the mode still starts, just without project content).
 *
 * Project mode is left alone: it deliberately means "only load when the project
 * already opted in".
 */

import { existsSync } from 'node:fs'
import path from 'node:path'

import {
  cliCandidates,
  defaultExecute,
  errorText,
  isMissingCommand,
  resolveTimeout,
} from './resolve.js'

/** Directory that marks an activated project. */
export const STACK_DIR = '.hnflow'
/** Activation file inside {@link STACK_DIR}. */
export const STACK_FILE = 'stack.json'

const MAX_BUFFER = 64 * 1024

/** In-flight activations, so two rows resolving one workspace spawn one `init`. */
const pending = new Map()

/**
 * Absolute path of a project's activation file.
 * @param {string} projectDir - absolute project directory.
 * @returns {string} path to `stack.json`.
 */
export function stackPath(projectDir) {
  return path.join(projectDir, STACK_DIR, STACK_FILE)
}

/**
 * Whether a project is already activated.
 * @param {string} projectDir - absolute project directory.
 * @returns {boolean} true when `stack.json` exists.
 */
export function stackExists(projectDir) {
  try {
    return existsSync(stackPath(projectDir))
  } catch {
    return false
  }
}

/**
 * Build the argv that initialises one project.
 *
 * `--project` is a global option, so it has to precede the subcommand.
 * @param {string} projectDir - absolute project directory.
 * @returns {string[]} argv after the executable.
 */
export function initArgs(projectDir) {
  return ['--project', projectDir, 'init']
}

/**
 * Create `<project>/.hnflow/stack.json` when the mode asks for it.
 *
 * Never throws: activation is a convenience, not a prerequisite for the mode.
 * @param {string} projectDir - absolute project directory.
 * @param {typeof import('./config.js').DEFAULT_CONFIG} config - resolved plugin config.
 * @param {(command: string, args: string[], options: Record<string, unknown>) => Promise<{stdout: string, stderr: string}>} [execute] - injectable spawn.
 * @returns {Promise<{created: boolean, skipped?: boolean, error?: string}>} outcome.
 */
export async function ensureStack(projectDir, config, execute = defaultExecute) {
  if (config?.autoActivate === false) return { created: false, skipped: true }
  if (config?.resolveMode === 'project') return { created: false, skipped: true }
  if (stackExists(projectDir)) return { created: false }

  const key = path.resolve(projectDir)
  const running = pending.get(key)
  if (running !== undefined) return running
  const task = runInit(projectDir, config, execute)
  pending.set(key, task)
  try {
    return await task
  } finally {
    pending.delete(key)
  }
}

/**
 * Spawn `hnflow-stack init` once.
 * @param {string} projectDir - absolute project directory.
 * @param {typeof import('./config.js').DEFAULT_CONFIG} config - resolved plugin config.
 * @param {Function} execute - spawn implementation.
 * @returns {Promise<{created: boolean, error?: string}>} outcome.
 */
async function runInit(projectDir, config, execute) {
  const options = { timeout: resolveTimeout(config?.timeoutMs), maxBuffer: MAX_BUFFER }
  let lastError = ''
  for (const command of cliCandidates(config?.command)) {
    try {
      await execute(command, initArgs(projectDir), options)
      return { created: stackExists(projectDir) }
    } catch (error) {
      if (isMissingCommand(error)) continue
      lastError = errorText(error)
      break
    }
  }
  return { created: false, error: lastError || 'command not found' }
}

/**
 * Activate the project if needed, then resolve its plan.
 * @param {string} projectDir - absolute project directory.
 * @param {typeof import('./config.js').DEFAULT_CONFIG} config - resolved plugin config.
 * @param {{execute?: Function, resolvePlan: (dir: string) => Promise<{plan: Record<string, unknown> | null, warnings: string[]}>}} deps - seams.
 * @returns {Promise<{plan: Record<string, unknown> | null, warnings: string[], activation: {created: boolean, skipped?: boolean, error?: string}}>} plan plus activation outcome.
 */
export async function activateAndResolve(projectDir, config, deps) {
  const activation = await ensureStack(projectDir, config, deps.execute)
  const result = await deps.resolvePlan(projectDir)
  if (activation.error) {
    return {
      ...result,
      warnings: [`cannot initialise ${STACK_FILE} in ${projectDir}: ${activation.error}`, ...result.warnings],
      activation,
    }
  }
  return { ...result, activation }
}
