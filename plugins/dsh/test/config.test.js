/**
 * Config coercion: every row value comes from YAML, so nothing is trusted.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_CONFIG, resolveConfig } from '../lib/config.js'

test('defaults are complete and immutable', () => {
  assert.equal(DEFAULT_CONFIG.host, true)
  assert.equal(DEFAULT_CONFIG.workspaceDir, '.hnflow')
  assert.deepEqual(DEFAULT_CONFIG.models, [])
  assert.equal(Object.isFrozen(DEFAULT_CONFIG), true)
})

test('scalars are coerced and wrong types fall back', () => {
  const config = resolveConfig({ engineModule: '  x.rpc  ', requestTimeoutMs: 5000, maxIndexEntries: 'nope', host: 'no' })
  assert.equal(config.engineModule, 'x.rpc')
  assert.equal(config.requestTimeoutMs, 5000)
  assert.equal(config.maxIndexEntries, DEFAULT_CONFIG.maxIndexEntries)
  assert.equal(config.host, true)
})

test('the model catalog keeps objects and drops everything else', () => {
  const config = resolveConfig({
    models: [
      { name: 'm1', use: 'deerflow.models.patched_deepseek:PatchedChatDeepSeek', model: 'm1' },
      'nope',
      null,
      ['nested'],
      { name: 'm2', model: 'm2' },
    ],
  })

  assert.equal(config.models.length, 2)
  assert.equal(config.models[0].name, 'm1')
  assert.equal(config.models[1].name, 'm2')
})

test('a non-array model catalog is ignored', () => {
  assert.deepEqual(resolveConfig({ models: { name: 'x' } }).models, [])
})
