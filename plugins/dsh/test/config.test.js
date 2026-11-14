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

test('the capability surface keys survive the row config', () => {
  // The capability half is configured through the same row config as HNFlow.
  // `resolveConfig` drops unknown keys, so a missing default here silently
  // returns `modelSelector: undefined` to CapabilityService, which degrades to
  // `additive` and moves the layer picker into the left strip.
  const config = resolveConfig({})
  assert.equal(config.modelSelector, 'replace')
  assert.equal(config.resolveMode, 'capabilities')
  assert.equal(config.autoActivate, true)
  assert.equal(config.timeoutMs, 5000)
  assert.equal(config.inventory, true)
  assert.equal(resolveConfig({ modelSelector: 'additive' }).modelSelector, 'additive')
  assert.equal(resolveConfig({ resolveMode: 'project' }).resolveMode, 'project')
  assert.equal(resolveConfig({ autoActivate: false }).autoActivate, false)
  assert.equal(resolveConfig({ timeoutMs: 9000 }).timeoutMs, 9000)
})

test('unknown values fall back instead of failing the row', () => {
  const config = resolveConfig({ role: 'nope', maxIndexEntries: null, presetAllowlist: [' a ', 3, ''] })
  assert.equal(config.role, DEFAULT_CONFIG.role)
  assert.equal(config.maxIndexEntries, DEFAULT_CONFIG.maxIndexEntries)
  assert.deepEqual(config.presetAllowlist, ['a'])
})
