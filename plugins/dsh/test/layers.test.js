/**
 * The VibeStack seam: apiVersion gate, bound/unbound/custom layers, lockfile
 * snapshot. These are the contracts a flow relies on for reproducibility.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  REQUIRED_API_VERSION,
  agentOptionsOf,
  layerStatus,
  vibestackAvailable,
  vibestackSnapshot,
  vibestackWarnings,
} from '../lib/layers.js'
import { fakeVibestack } from './helpers.js'

test('the seam requires apiVersion 3 plus resolveLayer and hasLayer', () => {
  assert.equal(REQUIRED_API_VERSION, 3)
  assert.equal(vibestackAvailable(fakeVibestack()), true)
  assert.equal(vibestackAvailable(fakeVibestack({ apiVersion: 2 })), false)
  const legacy = fakeVibestack()
  delete legacy.hasLayer
  assert.equal(vibestackAvailable(legacy), false)
  assert.equal(vibestackAvailable(undefined), false)
})

test('an old service fails loud instead of resolving a layer', async () => {
  const status = await layerStatus(fakeVibestack({ apiVersion: 2 }), 'strong')
  assert.equal(status.ok, false)
  assert.equal(status.code, 'vibestack-unavailable')
  assert.match(status.message, /apiVersion is below 3/u)
})

test('a catalog layer without a local route is unbound, not unknown', async () => {
  const service = fakeVibestack({ unbound: ['vision'] })
  const status = await layerStatus(service, 'vision')
  assert.equal(status.ok, false)
  assert.equal(status.code, 'model-layer-unbound')
  assert.match(status.message, /bindings\.dsh\.vision/u)
  const typo = await layerStatus(service, 'vison')
  assert.equal(typo.code, 'model-layer-unknown')
})

test('a DSH-only custom layer may not be pinned by a flow', async () => {
  const service = fakeVibestack({ custom: [{ id: 'local-max', provider: 'local', model: 'small' }] })
  assert.equal(service.hasLayer('local-max'), true)
  const status = await layerStatus(service, 'local-max')
  assert.equal(status.ok, false)
  assert.equal(status.code, 'model-layer-custom')
  assert.match(status.message, /custom layer/u)
})

test('a bound layer resolves, and an unroutable route is reported', async () => {
  const service = fakeVibestack()
  const ok = await layerStatus(service, 'strong')
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.layer, { id: 'strong', label: 'strong', description: '', kind: 'reasoning', rank: 3, provider: 'deepseek-account', model: 'deepseek-pro', reasoningEffort: 'high', bound: true, custom: false })
  const broken = fakeVibestack()
  broken.catalog = async () => ({ available: [], unroutable: [{ id: 'strong', reason: 'unknown model: deepseek-pro' }], error: undefined })
  const unroutable = await layerStatus(broken, 'strong')
  assert.equal(unroutable.ok, false)
  assert.equal(unroutable.code, 'model-layer-unroutable')
  assert.equal(unroutable.message, 'unknown model: deepseek-pro')
  const noLlm = fakeVibestack()
  noLlm.catalog = async () => ({ available: [], unroutable: [], error: 'llm service unavailable' })
  assert.equal((await layerStatus(noLlm, 'strong')).ok, true)
})

test('a resolved layer becomes spawn options and a lockfile snapshot', () => {
  const service = fakeVibestack()
  assert.deepEqual(agentOptionsOf(service.resolveLayer('standard')), { provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.deepEqual(agentOptionsOf(service.resolveLayer('strong')), { provider: 'deepseek-account', model: 'deepseek-pro', reasoningEffort: 'high' })
  assert.deepEqual(vibestackSnapshot(service), { available: true, apiVersion: 3 })
  assert.deepEqual(vibestackSnapshot(fakeVibestack({ apiVersion: 2 })), { available: false, apiVersion: 2 })
  assert.deepEqual(vibestackSnapshot(undefined), { available: false, apiVersion: null })
})

test('load warnings are surfaced for diagnostics and never throw', () => {
  assert.deepEqual(vibestackWarnings(fakeVibestack({ warnings: ['models.layers is a legacy DSH format'] })), ['models.layers is a legacy DSH format'])
  assert.deepEqual(vibestackWarnings(undefined), [])
  const hostile = fakeVibestack()
  hostile.listWarnings = () => {
    throw new Error('nope')
  }
  assert.deepEqual(vibestackWarnings(hostile), [])
})
