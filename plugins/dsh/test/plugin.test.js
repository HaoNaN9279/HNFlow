/**
 * Plugin wiring: what `apply()` registers, and what it degrades gracefully on.
 *
 * A fake Cordis context keeps this in-process, so it works without a running
 * harness (and without the sandbox EPERM on piped spawning).
 */

import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

/**
 * A minimal Cordis-shaped context.
 * @param {Record<string, any>} services - services to expose.
 * @returns {Record<string, any>} fake context.
 */
function fakeCtx(services) {
  /** @type {Map<string, Function[]>} */
  const listeners = new Map()
  /** @type {Function[]} */
  const effects = []
  /** @type {string[]} */
  const warnings = []
  const ctx = {
    logger: { warn: (message, ...args) => warnings.push(`${message} ${args.map((arg) => String(arg)).join(' ')}`) },
    get: (name) => services[name],
    inject: (names, callback) => {
      const scope = {}
      for (const name of names) scope[name] = services[name]
      callback(scope)
    },
    on: (event, handler) => {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
    },
    effect: (factory) => effects.push(factory()),
  }
  return { ctx, listeners, effects, warnings }
}

/**
 * A temp workspace holding one library asset and one ref.
 * @returns {Promise<{cwd: string, libraryRoot: string}>} fixture paths.
 */
async function makeWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hnflow-plugin-'))
  const cwd = path.join(root, 'workspace')
  const libraryRoot = path.join(root, 'library')
  const { createStores } = await import('../lib/resolve.js')
  const stores = createStores({ cwd, config: {}, libraryRoot, logger: {} })
  const created = await stores.assets.create({
    name: '发布流程',
    description: '构建 → 发布',
    definition: { id: 'release', name: 'Release', nodes: [{ id: 'start', type: 'flow:start' }], edges: [] },
  })
  await stores.workspace.addRef({ assetId: created.asset.id, alias: 'publish', revision: 1 })
  return { cwd, libraryRoot }
}

/**
 * Wire the plugin over one workspace.
 * @returns {Promise<Record<string, any>>} fixture: ctx, registrations, workspace.
 */
async function makePlugin() {
  const { cwd, libraryRoot } = await makeWorkspace()
  /** @type {Record<string, any>[]} */
  const commands = []
  /** @type {Record<string, any>[]} */
  const sections = []
  /** @type {Record<string, any>[]} */
  const tools = []
  /** @type {Record<string, any>[]} */
  const skills = []
  const session = { id: 'session-1' }
  const { ctx, listeners, effects, warnings } = fakeCtx({
    workingDirectory: { get: () => cwd },
    commands: { register: (command) => commands.push(command) },
    systemPrompt: { section: (section) => sections.push(section) },
    tools: { register: (tool) => tools.push(tool) },
    skills: { register: (skill) => skills.push(skill) },
  })
  apply(ctx, { libraryRoot })
  // Let the async registrations (skill file read, module import) settle.
  await new Promise((resolve) => setTimeout(resolve, 100))
  return { cwd, commands, sections, tools, skills, listeners, effects, warnings, session }
}

test('apply registers /workflow and the prompt section', async () => {
  const plugin = await makePlugin()

  assert.equal(plugin.commands.length, 1)
  assert.equal(plugin.commands[0].name, 'workflow')
  assert.match(plugin.commands[0].description, /HNFlow/u)

  assert.equal(plugin.sections.length, 1)
  assert.equal(plugin.sections[0].name, 'hnflow:workflows')
  assert.equal(plugin.sections[0].text({ agent: { session: plugin.session } }), '')
})

test('the bundled skill is registered with its frontmatter', async () => {
  const plugin = await makePlugin()
  assert.equal(plugin.skills.length, 1)
  assert.equal(plugin.skills[0].name, 'hnflow-workflow')
  assert.match(plugin.skills[0].description, /HNFlow/u)
  assert.match(plugin.skills[0].content, /三层关系/u)
})

test('pre-step refreshes the index the prompt section serves', async () => {
  const plugin = await makePlugin()
  const handlers = plugin.listeners.get('agent/pre-step') ?? []
  assert.equal(handlers.length, 1)

  const decision = await handlers[0]({ agent: { session: plugin.session } }, async () => ({ kind: 'allow' }))

  assert.deepEqual(decision, { kind: 'allow' })
  const text = plugin.sections[0].text({ agent: { session: plugin.session } })
  assert.match(text, /Call the `hnflow` tool/u)
  assert.match(text, /- publish — 构建 → 发布/u)
})

test('the tool row stays unregistered when dsh-tools is unavailable', async () => {
  const plugin = await makePlugin()
  assert.equal(plugin.tools.length, 0)
  assert.equal(
    plugin.warnings.some((line) => line.includes('cannot register the workflow tool')),
    true,
  )
})

test('dispose and the auto-resume timer run through registered effects', async () => {
  const plugin = await makePlugin()
  // The auto-resume timer is cancelled on dispose, and the engine is stopped.
  assert.equal(plugin.effects.length, 2)
  for (const effect of plugin.effects) {
    assert.equal(typeof effect, 'function')
    assert.equal(effect(), undefined)
  }
})
