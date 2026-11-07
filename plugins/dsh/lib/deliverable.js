/**
 * Deliverable path safety.
 *
 * A human delivery is data, never authority — but a path inside it can still
 * make a downstream tool write outside the workspace. The contract therefore
 * requires workspace-relative paths, and the plugin checks both lexically and
 * (when the host filesystem service is mounted) through `fs.contains`.
 *
 * Only path-shaped keys are checked: a deliverable may legitimately carry a
 * URL or a plain note, and rejecting those would turn a security rule into an
 * unrelated format rule.
 */

import path from 'node:path'

/** Keys whose string values are treated as filesystem paths. */
export const PATH_KEYS = /^(path|paths|file|files|filepath|filepaths|dir|directory|directories|target|targets)$/iu

/** A string that is a URL, not a filesystem path. */
const URL_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u

/** How deep and how many entries one payload may carry. */
const MAX_DEPTH = 8
const MAX_ENTRIES = 500

/**
 * Collect path-shaped strings from a delivery payload.
 * @param {unknown} payload - delivered JSON value.
 * @returns {{pointer: string, value: string}[]} path entries.
 */
export function collectDeliverablePaths(payload) {
  /** @type {{pointer: string, value: string}[]} */
  const found = []
  /**
   * @param {unknown} value - current value.
   * @param {string} pointer - JSON pointer-ish location.
   * @param {number} depth - recursion depth.
   * @param {boolean} underPathKey - whether an ancestor key was path-shaped.
   * @returns {void}
   */
  const walk = (value, pointer, depth, underPathKey) => {
    if (found.length >= MAX_ENTRIES || depth > MAX_DEPTH) return
    if (typeof value === 'string') {
      if (underPathKey && !URL_LIKE.test(value) && value.length > 0) found.push({ pointer, value })
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${pointer}[${index}]`, depth + 1, underPathKey))
      return
    }
    if (value === null || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      walk(child, pointer.length === 0 ? key : `${pointer}.${key}`, depth + 1, underPathKey || PATH_KEYS.test(key))
    }
  }
  walk(payload, '', 0, false)
  return found
}

/**
 * Check a delivery payload's paths against the workspace.
 *
 * @param {unknown} payload - delivered JSON value.
 * @param {{cwd: string, fs?: Record<string, any> | null, signal?: AbortSignal}} input - workspace root and optional filesystem service.
 * @returns {Promise<{ok: boolean, violations: {pointer: string, value: string, reason: string}[], warnings: string[]}>} result.
 */
export async function checkDeliverablePaths(payload, input) {
  const cwd = String(input.cwd ?? '')
  /** @type {{pointer: string, value: string, reason: string}[]} */
  const violations = []
  /** @type {string[]} */
  const warnings = []
  if (cwd.length === 0) {
    return { ok: true, violations, warnings: ['path-check-skipped: the run has no workspace'] }
  }
  const root = path.resolve(cwd)
  /** @type {Record<string, any> | null} */
  let fs = input.fs ?? null
  /** @type {unknown} */
  let rootTarget = null
  if (fs !== null && typeof fs.resolve === 'function' && typeof fs.contains === 'function') {
    try {
      rootTarget = await fs.resolve(root)
    } catch (error) {
      warnings.push(`path-check-degraded: fs.resolve failed (${String(error?.message ?? error)})`)
      fs = null
    }
  } else {
    fs = null
  }

  for (const entry of collectDeliverablePaths(payload)) {
    if (entry.value.includes('\0')) {
      violations.push({ ...entry, reason: 'contains a NUL byte' })
      continue
    }
    if (path.isAbsolute(entry.value) || /^[A-Za-z]:[\\/]/u.test(entry.value)) {
      violations.push({ ...entry, reason: 'must be workspace-relative, not absolute' })
      continue
    }
    const resolved = path.resolve(root, entry.value)
    const relative = path.relative(root, resolved)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      violations.push({ ...entry, reason: 'escapes the workspace' })
      continue
    }
    if (fs !== null && rootTarget !== null) {
      try {
        const childTarget = await fs.resolve(resolved)
        if (fs.contains(rootTarget, childTarget) !== true) {
          violations.push({ ...entry, reason: 'the filesystem says this path is outside the workspace' })
        }
      } catch (error) {
        warnings.push(`path-check-degraded for ${entry.pointer}: ${String(error?.message ?? error)}`)
      }
    }
  }
  return { ok: violations.length === 0, violations, warnings }
}
