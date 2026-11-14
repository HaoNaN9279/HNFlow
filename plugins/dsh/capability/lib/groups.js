/**
 * Capability group catalog for the workspace switcher window.
 *
 * The window lists INACTIVE groups too, which no resolved plan contains, so the
 * data comes from `hnflow-stack groups --json` instead of the plan cache. Writing
 * activation goes through `hnflow-stack activate|deactivate`, so `.hnflow/stack.json`
 * keeps exactly one writer and the plan cache notices the file change by itself.
 */

import path from 'node:path'

import { cliCandidates, defaultExecute, errorText, resolveTimeout, spawnCwd } from './resolve.js'

const MAX_BUFFER = 16 * 1024 * 1024

/**
 * Build argv for `groups --json`.
 * @param {string} project - workspace directory.
 * @param {string | null} repo - repository root, when known.
 * @returns {string[]} argv after the executable.
 */
export function groupsArgs(project, repo) {
  const pinned = repo === null ? [] : ['--repo', repo]
  return [...pinned, '--project', project, 'groups', '--json']
}

/**
 * Build argv for one activation write.
 * @param {string} project - workspace directory.
 * @param {string | null} repo - repository root.
 * @param {string} action - `activate` or `deactivate`.
 * @param {string} group - group name.
 * @returns {string[]} argv after the executable.
 */
export function selectArgs(project, repo, action, group) {
  const pinned = repo === null ? [] : ['--repo', repo]
  return [...pinned, '--project', project, action, group]
}

/**
 * Run one CLI call over the candidate executables.
 * @param {string[]} args - argv.
 * @param {{command?: string, timeoutMs?: number, cwd?: string}} config - plugin config.
 * @param {(command: string, args: string[], options: Record<string, unknown>) => Promise<{stdout: string, stderr: string}>} execute - spawn seam.
 * @returns {Promise<string>} captured stdout.
 * @throws {Error} with `code: 'cli-unavailable'` when no candidate runs.
 */
export async function runCli(args, config, execute) {
  const options = { timeout: resolveTimeout(config.timeoutMs), maxBuffer: MAX_BUFFER, cwd: spawnCwd(config.cwd ?? '') }
  let lastError = ''
  for (const command of cliCandidates(config.command)) {
    try {
      const result = await execute(command, args, options)
      return String(result.stdout ?? '')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        lastError = errorText(error)
        continue
      }
      throw Object.assign(new Error(errorText(error)), {
        code: 'cli-failed',
        stdout: String(error?.stdout ?? ''),
        stderr: String(error?.stderr ?? ''),
      })
    }
  }
  throw Object.assign(new Error(`hnflow-stack not found: ${lastError || 'command not found'}`), {
    code: 'cli-unavailable',
  })
}

/**
 * Read the workspace's group catalog.
 * @param {{project: string, repo: string | null, command?: string, timeoutMs?: number, execute?: Function}} options - wiring.
 * @returns {Promise<Record<string, unknown>>} parsed document.
 */
export async function loadGroups(options) {
  const execute = options.execute ?? defaultExecute
  const stdout = await runCli(
    groupsArgs(options.project, options.repo),
    { command: options.command, timeoutMs: options.timeoutMs, cwd: options.project },
    execute,
  )
  let parsed
  try {
    parsed = JSON.parse(String(stdout ?? '').replace(/^\uFEFF/u, ''))
  } catch {
    throw Object.assign(new Error('hnflow-stack groups returned invalid JSON'), { code: 'catalog-invalid' })
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.groups)) {
    throw Object.assign(new Error('hnflow-stack groups returned an invalid document'), { code: 'catalog-invalid' })
  }
  return parsed
}

/**
 * Turn one group on or off for a workspace.
 * @param {{project: string, repo: string | null, group: string, active: boolean, command?: string, timeoutMs?: number, execute?: Function}} options - wiring.
 * @returns {Promise<void>} resolves after the stack file was rewritten.
 */
export async function selectGroup(options) {
  const execute = options.execute ?? defaultExecute
  const action = options.active ? 'activate' : 'deactivate'
  await runCli(
    selectArgs(options.project, options.repo, action, options.group),
    { command: options.command, timeoutMs: options.timeoutMs, cwd: options.project },
    execute,
  )
}

/**
 * Find a content entry a preview may read.
 *
 * The catalog is the allowlist: a caller cannot pass an arbitrary path, only one
 * the CLI just reported for a group. That keeps the preview route from becoming
 * a file reader while still covering every content kind.
 * @param {Record<string, unknown>} document - catalog document.
 * @param {string} target - absolute path requested by the client.
 * @returns {{ok: true, item: Record<string, unknown>, group: Record<string, unknown>} | {ok: false, reason: string}} lookup.
 */
export function findContent(document, target) {
  const wanted = typeof target === 'string' ? path.resolve(target) : ''
  if (wanted.length === 0) return { ok: false, reason: 'path is required' }
  const groups = Array.isArray(document?.groups) ? document.groups : []
  for (const group of groups) {
    const contents = group?.contents
    if (contents === null || typeof contents !== 'object') continue
    for (const items of Object.values(contents)) {
      if (!Array.isArray(items)) continue
      for (const item of items) {
        if (typeof item?.path !== 'string') continue
        if (path.resolve(item.path) === wanted) return { ok: true, item, group }
      }
    }
  }
  return { ok: false, reason: 'path is not capability content' }
}
