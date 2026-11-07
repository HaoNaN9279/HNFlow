/**
 * Configuration coercion: every value comes from a patch and is untrusted.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_CONFIG, MAX_PARALLEL_CAP, resolveConfig } from '../lib/config.js'

test('maxParallel is clamped to the host activation cap', () => {
  assert.equal(resolveConfig({ maxParallel: 3 }).maxParallel, 3)
  assert.equal(resolveConfig({ maxParallel: 99 }).maxParallel, MAX_PARALLEL_CAP)
  assert.equal(resolveConfig({ maxParallel: 0 }).maxParallel, DEFAULT_CONFIG.maxParallel)
  assert.equal(resolveConfig({ maxParallel: -4 }).maxParallel, DEFAULT_CONFIG.maxParallel)
  assert.equal(resolveConfig({ maxParallel: 'many' }).maxParallel, DEFAULT_CONFIG.maxParallel)
})

test('unknown values fall back instead of failing the row', () => {
  const config = resolveConfig({ role: 'nope', maxIndexEntries: null, presetAllowlist: [' a ', 3, ''] })
  assert.equal(config.role, DEFAULT_CONFIG.role)
  assert.equal(config.maxIndexEntries, DEFAULT_CONFIG.maxIndexEntries)
  assert.deepEqual(config.presetAllowlist, ['a'])
})
