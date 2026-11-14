/**
 * Flows are capability-group content: listing, describing, creating, editing
 * and deleting all go through the project group tree.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { fakeCapability, gateFlow, makeService } from './helpers.js'
import { normalizePlan } from '../capability/lib/resolve.js'

/**
 * Seed a workspace with one project-local group and flow.
 * @param {Record<string, any>} definition - flow definition.
 * @returns {Promise<Record<string, any>>} paths.
 */
async function seedProject(definition) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hnflow-capability-'))
  const workspace = path.join(root, 'ws')
  const groupDir = path.join(workspace, '.hnflow', 'groups', 'team')
  const flowDir = path.join(groupDir, 'flows')
  await mkdir(flowDir, { recursive: true })
  await writeFile(path.join(groupDir, 'group.json'), `${JSON.stringify({ guid: 'a'.repeat(32), name: 'team', version: '', description: 'team flows' }, null, 2)}\n`, 'utf8')
  await writeFile(path.join(workspace, '.hnflow', 'stack.json'), `${JSON.stringify({ schema_version: 2, core: { name: 'core', version: '0.1.0' }, groups: [{ name: 'team', version: '' }], agents_md: 'off' }, null, 2)}\n`, 'utf8')
  const flowPath = path.join(flowDir, 'demo.flow.json')
  await writeFile(flowPath, `${JSON.stringify(definition, null, 2)}\n`, 'utf8')
  return { root, workspace, groupDir, flowDir, flowPath }
}

/**
 * A capability fake whose plan is the real project group tree.
 * @param {string} flowDir - flows directory.
 * @returns {Record<string, any>} fake.
 */
function capabilityOver(flowDir) {
  return {
    ...fakeCapability(),
    planFor: async () => {
      const names = (await readdir(flowDir)).filter((name) => name.endsWith('.flow.json')).sort()
      const flows = []
      for (const name of names) {
        const definition = JSON.parse(await readFile(path.join(flowDir, name), 'utf8'))
        flows.push({
          id: `team/${definition.flow.id}`,
          flow_id: definition.flow.id,
          name: definition.flow.name,
          group: 'team',
          path: path.join(flowDir, name),
          description: definition.flow.description ?? '',
          tags: definition.flow.tags ?? [],
          requires: [],
        })
      }
      return { plan: { flows }, warnings: [] }
    },
  }
}

test('a project flow is listed, described, edited, renamed and deleted', async () => {
  const definition = gateFlow()
  definition.flow = { id: 'fl-demo', name: '演示流程' }
  const seeded = await seedProject(definition)
  const service = await makeService({ capability: capabilityOver(seeded.flowDir) })
  try {
    const listed = await service.listFlows(seeded.workspace)
    assert.equal(listed.length, 1)
    assert.equal(listed[0].name, '演示流程')
    assert.equal(listed[0].group, 'team')
    assert.equal(listed[0].source, 'capability')

    const described = await service.describeFlow(seeded.workspace, '演示流程')
    assert.equal(described.flowId, 'fl-demo')
    assert.equal(described.definition.nodes.length, definition.nodes.length)

    const edited = await service.draft({
      cwd: seeded.workspace,
      key: '演示流程',
      definition: { ...definition, nodes: definition.nodes.map((node) => (node.id === 'draft' ? { ...node, instruction: '改过的任务' } : node)) },
      note: 'edit',
    })
    assert.equal(edited.local, true)
    const after = JSON.parse(await readFile(seeded.flowPath, 'utf8'))
    assert.equal(after.nodes.find((node) => node.id === 'draft').instruction, '改过的任务')

    const renamed = await service.renameLocal({ cwd: seeded.workspace, key: 'fl-demo', name: '改名流程' })
    assert.equal(renamed.name, '改名流程')
    assert.equal((await service.describeFlow(seeded.workspace, 'fl-demo')).flowName, '改名流程')

    await service.deleteLocal({ cwd: seeded.workspace, key: 'fl-demo' })
    assert.equal((await service.listFlows(seeded.workspace)).length, 0)
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})

test('the capabilities mode survives resolve normalization', () => {
  const plan = normalizePlan({ schema_version: 2, active: false, mode: 'capabilities', flows: [] })
  assert.equal(plan.mode, 'capabilities')
  assert.equal(plan.active, true)
  assert.deepEqual(plan.flows, [])
})

test('create writes a group and its flow, and activates the group', async () => {
  const seeded = await seedProject(gateFlow())
  const service = await makeService({ capability: capabilityOver(seeded.flowDir) })
  try {
    const created = await service.createFlow({
      cwd: seeded.workspace,
      definition: gateFlow(),
      name: '新流程',
      folder: 'review',
    })
    assert.equal(created.scope, 'project')
    assert.equal(created.group, 'review')
    assert.equal(created.key, 'review/fl-test')
    const file = path.join(seeded.workspace, '.hnflow', 'groups', 'review', 'flows', 'fl-test.flow.json')
    assert.equal(JSON.parse(await readFile(file, 'utf8')).flow.name, '新流程')
    const stack = JSON.parse(await readFile(path.join(seeded.workspace, '.hnflow', 'stack.json'), 'utf8'))
    assert.equal(stack.groups.some((group) => group.name === 'review'), true)
    const manifest = JSON.parse(await readFile(path.join(seeded.workspace, '.hnflow', 'groups', 'review', 'group.json'), 'utf8'))
    assert.equal(manifest.name, 'review')
  } finally {
    await service.close()
    await rm(seeded.root, { recursive: true, force: true })
  }
})
