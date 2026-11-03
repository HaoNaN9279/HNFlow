/**
 * Document helpers: canonical hashing and a compact structural diff.
 *
 * Both are used by the asset/override stores, so they stay pure and free of
 * filesystem access.
 */

import { createHash } from 'node:crypto'

/**
 * Serialize JSON with sorted object keys so equal documents hash equally.
 * @param {unknown} value - any JSON value.
 * @returns {string} canonical text.
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * Content hash of a JSON document.
 * @param {unknown} value - any JSON value.
 * @returns {string} `sha256:<hex>` fingerprint.
 */
export function hashOf(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

/**
 * Structural difference between two JSON documents.
 *
 * Only leaves and array lengths are reported: enough to show a user what a save
 * will change without rendering a full text diff.
 * @param {unknown} before - previous value.
 * @param {unknown} after - next value.
 * @param {{maxEntries?: number}} [options] - report bound.
 * @returns {{path: string, from: unknown, to: unknown}[]} changed leaves.
 */
export function diffDocuments(before, after, options = {}) {
  const maxEntries = Number.isFinite(options.maxEntries) ? Number(options.maxEntries) : 20
  /** @type {{path: string, from: unknown, to: unknown}[]} */
  const changes = []

  /**
   * Walk both values in lockstep.
   * @param {unknown} left - previous value.
   * @param {unknown} right - next value.
   * @param {string} prefix - dotted path so far.
   * @returns {void}
   */
  const walk = (left, right, prefix) => {
    if (changes.length >= maxEntries) return
    if (canonicalJson(left) === canonicalJson(right)) return
    const bothObjects = left !== null && right !== null && typeof left === 'object' && typeof right === 'object' && Array.isArray(left) === Array.isArray(right)
    if (bothObjects) {
      const keys = new Set([...Object.keys(left), ...Object.keys(right)])
      for (const key of [...keys].sort()) {
        walk(left[key], right[key], prefix.length === 0 ? key : `${prefix}.${key}`)
        if (changes.length >= maxEntries) return
      }
      return
    }
    changes.push({ path: prefix.length === 0 ? '.' : prefix, from: left, to: right })
  }

  walk(before, after, '')
  return changes
}
