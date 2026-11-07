/**
 * Legacy import: the two shipped v1 examples must convert into valid v2
 * definitions, and the trivial one must actually run.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, rm } from 'node:fs/promises'

import { convertDefinition, formatImportReport, isLegacyDefinition } from '../lib/import.js'
import { validateFlow } from '../lib/flow/validate.js'
import { makeService, seedWorkspace } from './helpers.js'

/**
 * Read one shipped legacy example.
 * @param {string} name - file name.
 * @returns {Promise<Record<string, any>>} parsed document.
 */
async function legacy(name) {
  const url = new URL(`../../../config-examples/workflows/${name}`, import.meta.url)
  return JSON.parse(await readFile(url, 'utf8'))
}

test('the hello example converts to a single constant merge and runs', async () => {
  const converted = convertDefinition(await legacy('hello.workflow.json'))
  assert.equal(converted.report.legacy, true)
  assert.equal(converted.definition.schemaVersion, 2)
  assert.equal(converted.definition.nodes.length, 1)
  assert.equal(converted.definition.nodes[0].type, 'merge')
  assert.deepEqual(converted.definition.nodes[0].set, { out: 'hello from HNFlow' })
  assert.equal((await validateFlow(converted.definition)).ok, true)
  assert.match(formatImportReport(converted.report), /flow:start/u)

  const seeded = await seedWorkspace(converted.definition)
  const service = await makeService({ config: { libraryRoot: seeded.library } })
  try {
    const run = await (await service.run({ cwd: seeded.workspace, key: 'demo', input: {} })).settled
    assert.equal(run.status, 'succeeded')
    assert.deepEqual(run.nodes.greet.output, { out: 'hello from HNFlow' })
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('the verification example keeps its three branches and validates', async () => {
  const converted = convertDefinition(await legacy('verification.workflow.json'))
  assert.equal(converted.report.legacy, true)
  const gate = converted.definition.nodes.find((node) => node.id === 'gate')
  assert.equal(gate.type, 'gate')
  const conditions = converted.definition.edges.filter((edge) => edge.from === 'gate').map((edge) => edge.when.is).sort()
  assert.deepEqual(conditions, ['approved', 'modified', 'rejected'])
  assert.equal(converted.definition.nodes.some((node) => node.id === 'v2-end'), true)
  const validation = await validateFlow(converted.definition)
  assert.deepEqual(validation.errors, [])
})

test('a v2 definition is returned untouched', async () => {
  const definition = { schemaVersion: 2, flow: { id: 'fl-x', name: 'x' }, input: { type: 'object' }, nodes: [{ id: 'g', type: 'gate' }], edges: [] }
  assert.equal(isLegacyDefinition(definition), false)
  const converted = convertDefinition(definition)
  assert.equal(converted.report.legacy, false)
  assert.equal(converted.definition, definition)
})
