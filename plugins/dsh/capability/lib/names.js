/**
 * Canonical Capability names for DSH.
 *
 * DSH command names and skill names share a lowercase grammar, so a capability
 * group's display name can never be used verbatim. Every capability-group
 * command and skill is published as `capability-<group>-<name>`; agents keep
 * their Capability name because they are shown as session personas, not
 * registered DSH identifiers.
 */

import { createHash } from 'node:crypto'

/** Default namespace prefix. */
export const DEFAULT_PREFIX = 'capability'
/** Default maximum published name length. */
export const DEFAULT_MAX_NAME_LENGTH = 48

/** DSH command-name grammar. */
export const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u
/** DSH skill-name grammar. */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/**
 * Normalise one display name into a lowercase kebab token.
 * @param {unknown} value - group or item name.
 * @returns {string} usable token, or an empty string when nothing remains.
 */
export function slug(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-+|-+$/gu, '')
}

/**
 * Stable short hash used when a canonical name must be truncated.
 * @param {string} value - hash input.
 * @param {number} [length] - hex characters to keep.
 * @returns {string} lowercase hex.
 */
export function shortHash(value, length = 6) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, length)
}

/**
 * Build the canonical name for one capability-group entry.
 * @param {string} prefix - namespace prefix (`capability`).
 * @param {string} group - capability group name.
 * @param {string} name - command or skill name from the group.
 * @param {{maxLength?: number}} [options] - length limit.
 * @returns {string} canonical name, or an empty string when the name has no usable characters.
 */
export function canonicalName(prefix, group, name, options = {}) {
  const lead = slug(prefix) || DEFAULT_PREFIX
  const groupSlug = slug(group) || 'unknown'
  const nameSlug = slug(name)
  if (nameSlug.length === 0) return ''
  const configured = Number(options.maxLength)
  const max = Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_MAX_NAME_LENGTH
  const parts = [lead, groupSlug, nameSlug]
  const joined = parts.join('-')
  if (joined.length <= max) return joined

  const hash = shortHash(`${group}/${name}`)
  const head = joined.slice(0, Math.max(1, max - hash.length - 1)).replace(/-+$/gu, '')
  return `${head}-${hash}`
}

/**
 * Whether a canonical command name can be registered on DSH.
 * @param {unknown} name - canonical name.
 * @returns {boolean} true when the grammar accepts it.
 */
export function validCommandName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 64 && COMMAND_NAME.test(name)
}

/**
 * Whether a canonical skill name can be registered on DSH.
 * @param {unknown} name - canonical name.
 * @returns {boolean} true when the grammar accepts it.
 */
export function validSkillName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 64 && SKILL_NAME.test(name)
}
