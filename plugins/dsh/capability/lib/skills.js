/**
 * Capability-group skills as a DSH skill provider.
 *
 * The provider reports the paths the resolver validated; it never scans
 * capability-group directories and never decides which version wins. Skill
 * bodies are read on demand and frontmatter is stripped because the resolver
 * already validated and reported the metadata.
 *
 * DSH skill names are kebab-only, so every capability-group skill is published
 * as `capability-<group>-<name>`; the on-disk directory name stays untouched.
 */

import path from 'node:path'

import { canonicalName, validSkillName } from './names.js'
import { stripFrontmatter } from './rules.js'

/** Provider name registered on `ctx.skills`. */
export const PROVIDER_NAME = 'capability'
/** Project-level rank: after `.dsh/skills` and `.agents/skills`, before custom roots. */
export const SKILL_RANK = 250

/**
 * Map resolved skills to provider-neutral candidates.
 * @param {Record<string, unknown>} plan - normalized resolve plan.
 * @param {{prefix?: string, maxLength?: number, rank?: number}} [options] - namespace options.
 * @param {string[]} [warnings] - collector for dropped or colliding entries.
 * @returns {{name: string, originalName: string, description: string, directory: string, group: string, model: string}[]} unique candidates in plan order.
 */
export function skillCandidates(plan, options = {}, warnings = []) {
  const published = plan?.names && typeof plan.names === 'object' ? plan.names : {}
  const assigned = published.skills && typeof published.skills === 'object' ? published.skills : {}
  const seen = new Set()
  const candidates = []
  const skills = Array.isArray(plan?.skills) ? plan.skills : []
  for (const skill of skills) {
    if (!skill || typeof skill.name !== 'string' || typeof skill.path !== 'string') continue
    if (skill.name.length === 0 || skill.path.length === 0) continue
    const group = typeof skill.group === 'string' && skill.group.length > 0 ? skill.group : 'core'
    const id = typeof skill.id === 'string' && skill.id.length > 0 ? skill.id : ''
    const mapped = id.length > 0 && typeof assigned[id] === 'string' ? assigned[id] : ''
    const canonical = mapped.length > 0
      ? mapped
      : canonicalName(options.prefix, group, skill.name, options)
    if (canonical.length === 0) {
      warnings.push(`skill ${group}/${skill.name} has no usable name`)
      continue
    }
    if (!validSkillName(canonical)) {
      warnings.push(`skill ${group}/${skill.name} produces an invalid DSH name: ${canonical}`)
      continue
    }
    if (seen.has(canonical)) {
      warnings.push(`skill name collision: ${canonical}`)
      continue
    }
    seen.add(canonical)
    candidates.push({
      name: canonical,
      originalName: skill.name,
      description: typeof skill.description === 'string' ? skill.description : '',
      directory: skill.path,
      group,
      model: typeof skill.model === 'string' ? skill.model : '',
    })
  }
  return candidates
}

/**
 * Build one DSH skill candidate.
 * @param {{name: string, description: string, directory: string}} entry - resolved skill.
 * @param {{rank?: number}} [options] - rank override.
 * @returns {Record<string, unknown>} provider candidate.
 */
export function toCandidate(entry, options = {}) {
  const directory = entry.directory
  const file = path.join(directory, 'SKILL.md')
  const rank = Number.isFinite(options.rank) && options.rank >= 0 ? Math.floor(options.rank) : SKILL_RANK
  return {
    name: entry.name,
    description: entry.description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER_NAME,
    source: 'capability',
    rank,
    locator: { path: file, directory },
    resourceBase: { kind: 'directory', path: directory },
    path: file,
  }
}

/**
 * Create the provider object handed to `ctx.skills.registerProvider`.
 * @param {{getPlan: (cwd: string) => Promise<Record<string, unknown> | null>, read?: (file: string) => Promise<string>, names?: {prefix?: string, maxLength?: number, rank?: number}, isUsable?: (plan: Record<string, unknown> | null) => boolean}} deps - plan lookup and reader.
 * @returns {{name: string, list: Function, get: Function}} provider.
 */
export function createSkillProvider(deps) {
  const read = deps.read ?? (async (file) => {
    const { readFile } = await import('node:fs/promises')
    return readFile(file, 'utf8')
  })
  const names = deps.names ?? {}
  const isUsable = deps.isUsable ?? ((plan) => plan !== null && plan !== undefined && plan.active === true)
  return {
    name: PROVIDER_NAME,
    async list(options = {}) {
      const cwd = options?.cwd
      if (typeof cwd !== 'string' || cwd.length === 0) return []
      const plan = await deps.getPlan(cwd)
      if (!isUsable(plan)) return []
      return skillCandidates(plan, names).map((entry) => toCandidate(entry, names))
    },
    async get(candidate) {
      const file = candidate?.locator?.path
      if (typeof file !== 'string' || file.length === 0) return undefined
      const text = await read(file)
      return {
        name: candidate.name,
        description: candidate.description,
        invocation: candidate.invocation ?? { modelInvocable: true, userInvocable: true },
        provider: PROVIDER_NAME,
        source: 'capability',
        resourceBase: candidate.resourceBase,
        path: file,
        content: stripFrontmatter(text),
      }
    },
  }
}

/**
 * Read the plugin's own skill bundle.
 *
 * This is only used for the plugin's bundled `capability` skill; capability
 * group files are validated by the resolver and never parsed here.
 * @param {string} text - raw `SKILL.md` content.
 * @returns {{name: string, description: string, content: string}} parsed skill.
 */
export function readSkillFile(text) {
  const value = String(text ?? '').replace(/^\uFEFF/u, '')
  const name = (value.match(/^name:\s*(.+)$/mu)?.[1] ?? '').trim()
  const description = (value.match(/^description:\s*(.+)$/mu)?.[1] ?? '').trim()
  return { name, description, content: stripFrontmatter(value) }
}
