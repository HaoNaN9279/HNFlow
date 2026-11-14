/**
 * Rule rendering.
 *
 * Capability-group rules are workspace instructions, so they reach the model the way
 * `dsh-agent-instructions` delivers AGENTS.md: one persistent user-role
 * `<system-reminder>` message. Only the rule body is used; the resolver already
 * validated the frontmatter.
 *
 * Only the session working directory is known when a step starts, so scoping is
 * decided per directory subtree: `global` rules always apply, `paths` rules
 * apply when the working directory matches. Rules pinned with `on_demand: true`
 * are listed by path and description only; the model can read them on demand.
 *
 * `planRules` is the single decision point: the injection path only formats its
 * result, and the session inventory panel reuses it, so what the panel reports
 * cannot drift from what the model receives.
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const CLOSING = '</system-reminder>'
const INDEX_LINE_MAX = 120
export const RULES_HEADER = [
  '<system-reminder>',
  "The following workspace instructions come from this project's HNFlow capability groups. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.",
].join('\n\n')
export const RULES_FOOTER = '</system-reminder>'
export const INDEX_LEAD =
  'Some HNFlow rules are loaded on demand: only their summary is listed here. Read the file before working on its topic:'

/**
 * Remove a leading YAML frontmatter block.
 * @param {string} text - raw file content.
 * @returns {string} trimmed body without frontmatter.
 */
export function stripFrontmatter(text) {
  const value = String(text ?? '').replace(/^\uFEFF/u, '')
  if (!value.startsWith('---')) return value.trim()
  const close = value.indexOf('\n---', 3)
  if (close === -1) return value.trim()
  const bodyStart = value.indexOf('\n', close + 4)
  return (bodyStart === -1 ? '' : value.slice(bodyStart + 1)).trim()
}

/**
 * Neutralise a literal closing tag inside plugin-controlled framing.
 * @param {string} text - untrusted rule text.
 * @returns {string} text that cannot close the reminder early.
 */
export function escapeReminder(text) {
  return String(text ?? '').replaceAll(CLOSING, '&lt;/system-reminder&gt;')
}

/**
 * Hash rendered instructions for idempotent injection.
 * @param {string} text - rendered message body.
 * @returns {string} sha256 hex digest.
 */
export function digestOf(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

/**
 * Normalise a project-relative path for glob comparison.
 * @param {unknown} value - path from the plan or the host.
 * @returns {string} posix-style relative path without leading or trailing slashes.
 */
export function normalizePath(value) {
  return String(value ?? '')
    .replace(/\\/gu, '/')
    .replace(/^\/+/u, '')
    .replace(/\/+$/u, '')
}

/**
 * Match one project-relative path against one rule glob.
 * A trailing `/**` selects the directory itself and its whole subtree.
 * @param {string} relative - normalised project-relative path.
 * @param {string} pattern - rule glob.
 * @returns {boolean} true when the path is inside the pattern.
 */
export function matchPath(relative, pattern) {
  const glob = normalizePath(pattern)
  if (glob.length === 0) return true
  if (glob.endsWith('/**')) {
    const prefix = glob.slice(0, -3)
    return relative === prefix || relative.startsWith(`${prefix}/`)
  }
  if (glob.endsWith('/*')) {
    const prefix = glob.slice(0, -2)
    return relative.startsWith(`${prefix}/`) && !relative.slice(prefix.length + 1).includes('/')
  }
  let index = 0
  for (const segment of glob.split('/')) {
    const next = relative.indexOf(segment, index)
    if (next === -1) return false
    index = next + segment.length
  }
  return true
}

/**
 * Whether one rule is injected for a working directory.
 * @param {Record<string, unknown>} rule - plan rule entry.
 * @param {string} relative - normalised project-relative working directory.
 * @returns {boolean} true when the rule applies.
 */
export function ruleApplies(rule, relative) {
  const scope = typeof rule.scope === 'string' ? rule.scope : 'global'
  if (scope === 'global') return true
  const declared = Array.isArray(rule.paths)
    ? rule.paths.filter((item) => typeof item === 'string' && item.length > 0)
    : []
  const patterns = declared
  if (patterns.length === 0) return true
  if (relative.length === 0) return false
  return patterns.some((pattern) => matchPath(relative, pattern))
}

/**
 * One-line description for a rule that stays out of the injected text.
 * @param {Record<string, unknown>} rule - plan rule entry.
 * @returns {string} at most INDEX_LINE_MAX characters.
 */
export function indexSummary(rule) {
  const described = typeof rule.description === 'string' ? rule.description.trim() : ''
  const text = described.length > 0 ? described : String(rule.name ?? rule.id ?? 'rule')
  return text.length <= INDEX_LINE_MAX ? text : `${text.slice(0, INDEX_LINE_MAX - 1)}…`
}

/**
 * One index line for a rule pinned with `on_demand: true`.
 * @param {Record<string, unknown>} rule - plan rule entry.
 * @returns {string} rendered index line.
 */
export function indexLine(rule) {
  return `- ${String(rule.path ?? rule.id ?? rule.name)}: ${indexSummary(rule)}`
}

/**
 * Decide the rules message content for one directory.
 * @param {Record<string, unknown>} plan - normalized resolve plan.
 * @param {{read?: (file: string) => Promise<string>, maxBytes?: number, cwd?: string}} [options] - injectable reader, budget and working directory.
 * @returns {Promise<{text: string | null, injected: Array<object>, indexed: Array<object>, skipped: Array<object>, omitted: Array<object>, used: number, limit: number, paths: string[]}>} planned rules message.
 */
export async function planRules(plan, options = {}) {
  const read = options.read ?? ((file) => readFile(file, 'utf8'))
  const limit = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : 65536
  const relative = normalizePath(options.cwd)
  const candidates = (Array.isArray(plan?.rules) ? plan.rules : [])
    .filter((rule) => rule && typeof rule.path === 'string' && rule.path.length > 0)

  const applicable = []
  const skipped = []
  for (const rule of candidates) {
    if (ruleApplies(rule, relative)) applicable.push(rule)
    else skipped.push(rule)
  }

  const injected = []
  const indexed = []
  const omitted = []
  const parts = []
  const paths = []
  const indexLines = []
  let bytes = Buffer.byteLength(RULES_HEADER, 'utf8') + Buffer.byteLength(RULES_FOOTER, 'utf8')
  let stopped = false

  for (const rule of applicable) {
    if (stopped) {
      omitted.push({ rule, status: 'omitted', bytes: 0, body: '' })
      continue
    }
    if (rule.on_demand === true) {
      const line = indexLine(rule)
      indexLines.push(line)
      indexed.push({ rule, status: 'indexed', bytes: Buffer.byteLength(line, 'utf8'), body: '' })
      continue
    }
    let body
    try {
      body = stripFrontmatter(await read(rule.path))
    } catch {
      omitted.push({ rule, status: 'omitted', bytes: 0, body: '' })
      continue
    }
    if (body.length === 0) {
      omitted.push({ rule, status: 'omitted', bytes: 0, body: '' })
      continue
    }
    const scope = rule.group ? ` (group: ${String(rule.group)})` : ''
    const block = `Instructions from: ${rule.path}${scope}\n\n${escapeReminder(body)}`
    const size = Buffer.byteLength(block, 'utf8')
    if (bytes + size > limit) {
      parts.push(`[HNFlow: remaining rules were omitted to stay within ${limit} bytes]`)
      omitted.push({ rule, status: 'omitted', bytes: size, body, block })
      stopped = true
      continue
    }
    bytes += size
    parts.push(block)
    paths.push(rule.path)
    injected.push({ rule, status: 'injected', bytes: size, body, block })
  }

  if (indexLines.length > 0) {
    const index = [INDEX_LEAD, ...indexLines].join('\n')
    const size = Buffer.byteLength(index, 'utf8')
    if (bytes + size <= limit) {
      bytes += size
      parts.push(index)
    } else {
      for (const entry of indexed) entry.status = 'omitted'
    }
  }

  const text = parts.length === 0 ? null : `${RULES_HEADER}\n\n${parts.join('\n\n')}\n${RULES_FOOTER}`
  return { text, injected, indexed, skipped, omitted, used: bytes, limit, paths }
}

/**
 * Render the rules message for one plan at one working directory.
 * @param {Record<string, unknown>} plan - normalized resolve plan.
 * @param {{read?: (file: string) => Promise<string>, maxBytes?: number, cwd?: string}} [options] - injectable reader, budget and working directory.
 * @returns {Promise<{text: string, digest: string, paths: string[]} | null>} rendered rules, or null when empty.
 */
export async function renderRules(plan, options = {}) {
  const planned = await planRules(plan, options)
  if (planned.text === null) return null
  return { text: planned.text, digest: digestOf(planned.text), paths: planned.paths }
}
