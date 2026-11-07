/**
 * Document helpers: canonical hashing.
 *
 * Used by the asset/override stores, so it stays pure and free of filesystem
 * access.
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
