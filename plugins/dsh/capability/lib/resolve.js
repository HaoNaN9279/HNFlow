/**
 * The only boundary between this plugin and HNFlow: `hnflow-stack resolve`.
 *
 * The plugin never scans capability groups, chooses versions, resolves
 * `extends`, or parses frontmatter. Every failure is reported as a warning and
 * an absent plan, so the mode still starts and DSH stays usable.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Resolve API versions this adapter understands. */
export const RESOLVE_SCHEMA_VERSIONS = Object.freeze([2])
/** Version emitted by the resolver this adapter ships with. */
export const RESOLVE_SCHEMA_VERSION = 2

const MAX_BUFFER = 16 * 1024 * 1024
/** This plugin's own package directory, used as a repository starting point. */
const PLUGIN_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * Find the HNFlow repository that owns a workspace.
 *
 * `hnflow-stack resolve` needs a repository to read `capability-groups` from and
 * otherwise falls back to *its own process cwd* — which belongs to the host
 * application, not to the project, so the mode failed with "repository not
 * found" even in an activated workspace. The repository is discovered from the
 * workspace upwards (a project may live inside the repository) and then from
 * this plugin's own package upwards (an installed plugin still knows which
 * repository it came from).
 * @param {string} projectDir - absolute workspace directory.
 * @returns {string | null} repository root, or null when none is known.
 */
export function repoFor(projectDir) {
  for (const start of [projectDir, PLUGIN_ROOT]) {
    if (typeof start !== 'string' || start.length === 0) continue
    let current = path.resolve(start)
    for (;;) {
      try {
        if (existsSync(path.join(current, 'capability-groups'))) return current
      } catch {
        /* ignore an unreadable ancestor and keep walking */
      }
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  return null
}

/**
 * Candidate executables, in priority order.
 * @param {string} configured - explicit path from row config.
 * @returns {string[]} non-empty candidates.
 */
export function cliCandidates(configured) {
  const candidates = [configured, process.env.CAPABILITY_CLI]
  if (process.platform === 'win32') candidates.push('hnflow-stack.exe')
  candidates.push('hnflow-stack')
  // `pipx`/`pip --user` install the launcher under the user's home, which is on
  // PATH for a terminal but not necessarily for a desktop app launched from the
  // shell's login environment. Try the known home bin directory explicitly.
  candidates.push(...homeCandidates())
  return [...new Set(candidates.filter((value) => typeof value === 'string' && value.length > 0))]
}

/**
 * Launchers installed under the user's home directory.
 * @returns {string[]} absolute candidate paths.
 */
function homeCandidates() {
  let home = ''
  try {
    home = os.homedir()
  } catch {
    return []
  }
  if (home.length === 0) return []
  const names = process.platform === 'win32' ? ['hnflow-stack.exe', 'hnflow-stack'] : ['hnflow-stack']
  return names.map((name) => path.join(home, '.local', 'bin', name))
}

/**
 * Resolve the effective timeout, honouring the environment override.
 * @param {number} configured - row config value.
 * @returns {number} timeout in milliseconds.
 */
export function resolveTimeout(configured) {
  const raw = Number(process.env.CAPABILITY_RESOLVE_TIMEOUT_MS)
  if (Number.isFinite(raw) && raw > 0) return raw
  return Number.isFinite(configured) && configured > 0 ? configured : 5000
}

/**
 * Parse and version-check resolve output.
 * @param {string} stdout - raw command output.
 * @returns {Record<string, unknown>} the validated plan envelope.
 * @throws {Error} when the payload is not JSON or uses another schema version.
 */
export function parsePlan(stdout) {
  let parsed
  try {
    parsed = JSON.parse(String(stdout ?? '').replace(/^\uFEFF/u, ''))
  } catch {
    throw new Error('response is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('response is not a JSON object')
  }
  if (!RESOLVE_SCHEMA_VERSIONS.includes(parsed.schema_version)) {
    throw new Error(`unsupported schema_version: ${String(parsed.schema_version)}`)
  }
  return parsed
}

/**
 * Normalise one plan into the fields the plugin maps.
 * @param {Record<string, unknown>} plan - validated resolve envelope.
 * @returns {Record<string, unknown>} plan with defensive defaults.
 */
export function normalizePlan(plan) {
  const record = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})
  const list = (value) => (Array.isArray(value) ? value : [])
  const mode = plan.mode === 'capabilities' ? 'capabilities' : 'project'
  return {
    ...plan,
    active: plan.active === true || mode === 'capabilities',
    mode,
    project: typeof plan.project === 'string' ? plan.project : '',
    core: plan.core && typeof plan.core === 'object' && !Array.isArray(plan.core) ? plan.core : null,
    rules: list(plan.rules),
    skills: list(plan.skills),
    agents: record(plan.agents),
    commands: record(plan.commands),
    mcp: record(plan.mcp),
    names: record(plan.names),
    warnings: list(plan.warnings).filter((item) => typeof item === 'string'),
  }
}

/**
 * Build the argv for one resolve call.
 *
 * `--repo` is a global option, so it has to precede the subcommand; it pins the
 * repository the CLI reads instead of letting it depend on the host's cwd.
 * @param {string} projectDir - absolute session working directory.
 * @param {{resolveMode?: string}} config - resolved plugin config.
 * @returns {string[]} argv after the executable.
 */
export function resolveArgs(projectDir, config) {
  const mode = config.resolveMode === 'project' ? 'project' : 'capabilities'
  const repo = repoFor(projectDir)
  const pinned = repo === null ? [] : ['--repo', repo]
  return [...pinned, '--project', projectDir, 'resolve', '--json', '--mode', mode]
}

/**
 * Directory to spawn the CLI in.
 *
 * Running inside the project makes relative output and any CLI fallback paths
 * agree with the workspace, but a spawn `cwd` that no longer exists fails with a
 * misleading `ENOENT`, so an unusable directory falls back to the inherited one.
 * @param {string} projectDir - absolute project directory.
 * @returns {string | undefined} existing directory, or undefined to inherit.
 */
export function spawnCwd(projectDir) {
  if (typeof projectDir !== 'string' || projectDir.length === 0) return undefined
  try {
    if (!existsSync(projectDir)) return undefined
  } catch {
    return undefined
  }
  return projectDir
}

/**
 * Run `hnflow-stack resolve --json [--mode <mode>] --project <dir>`.
 * @param {string} projectDir - absolute session working directory.
 * @param {import('./config.js').DEFAULT_CONFIG} config - resolved plugin config.
 * @param {(command: string, args: string[], options: Record<string, unknown>) => Promise<{stdout: string, stderr: string}>} [execute] - injectable spawn.
 * @returns {Promise<{plan: Record<string, unknown> | null, warnings: string[]}>} plan or warnings.
 */
export async function resolvePlan(projectDir, config, execute = defaultExecute) {
  const args = resolveArgs(projectDir, config)
  const options = { timeout: resolveTimeout(config.timeoutMs), maxBuffer: MAX_BUFFER, cwd: spawnCwd(projectDir) }
  const warnings = []
  let lastError = ''
  for (const command of cliCandidates(config.command)) {
    let result
    try {
      result = await execute(command, args, options)
    } catch (error) {
      lastError = errorText(error)
      if (isMissingCommand(error)) continue
      break
    }
    try {
      const plan = normalizePlan(parsePlan(result.stdout))
      warnings.push(...plan.warnings)
      return { plan, warnings }
    } catch (error) {
      return { plan: null, warnings: [`hnflow-stack resolve returned an invalid plan: ${errorText(error)}`] }
    }
  }
  return { plan: null, warnings: [`hnflow-stack resolve failed: ${lastError || 'command not found'}`] }
}

/**
 * Default spawn implementation.
 * @param {string} command - executable.
 * @param {string[]} args - argv.
 * @param {{timeout: number, maxBuffer: number, cwd?: string}} options - spawn limits and working directory.
 * @returns {Promise<{stdout: string, stderr: string}>} captured output.
 */
export function defaultExecute(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf8',
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        windowsHide: true,
        ...(typeof options.cwd === 'string' && options.cwd.length > 0 ? { cwd: options.cwd } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }))
          return
        }
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      },
    )
  })
}

/**
 * Whether a spawn failure means the executable is absent.
 * @param {unknown} error - spawn failure.
 * @returns {boolean} true for ENOENT.
 */
export function isMissingCommand(error) {
  return Boolean(error && typeof error === 'object' && error.code === 'ENOENT')
}

/**
 * Prefer captured stderr, then the error message.
 * @param {unknown} error - failure value.
 * @returns {string} human-readable text.
 */
export function errorText(error) {
  if (error && typeof error === 'object') {
    const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : ''
    if (stderr) return stderr
  }
  if (error instanceof Error) return error.message
  return String(error)
}
