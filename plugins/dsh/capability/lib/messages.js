/**
 * Message helpers.
 *
 * DSH builds injected user messages with `createUserMessage` from
 * `@deepseek-ai/dsh-llm`, which is a branded `{ ...input, role: 'user', id }`
 * deep-frozen value. The brand is a compile-time type only, so this module
 * reproduces the same runtime shape without importing a DSH package.
 */

import { randomUUID } from 'node:crypto'

/**
 * Deep-freeze a detached value.
 * @template T
 * @param {T} value - value to freeze recursively.
 * @returns {T} the same value, frozen.
 */
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/**
 * Build one identified, immutable user-role message.
 * @param {{ content: unknown[], source: Record<string, unknown>, [key: string]: unknown }} input - message body.
 * @returns {Readonly<Record<string, unknown>>} frozen message with a fresh id.
 */
export function createUserMessage(input) {
  return deepFreeze(structuredClone({ ...input, role: 'user', id: randomUUID() }))
}
