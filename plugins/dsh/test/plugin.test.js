/**
 * Plugin assembly: the core row provides the service and routes, the preset row
 * registers the tools/command/skill/section, and the UI row registers nothing.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { Config, apply } from '../index.js'

/**
 * Build a fake Cordis context.
 * @returns {Record<string, any>} context plus captured registrations.
 */
function fakeContext() {
  /** @type {Record<string, any>} */
  const services = {}
  services.workingDirectory = { get: () => '/w' }
  /** @type {Record<string, any[]>} */
  const registered = { tools: [], commands: [], skills: [], sections: [] }
  /** @type {Record<string, any>[]} */
  const routes = []
  /** @type {Function[]} */
  const effects = []
  /** @type {Record<string, Function[]>} */
  const listeners = {}
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    services,
    registered,
    routes,
    effects,
    listeners,
    get(key) {
      if (key === 'workingDirectory') return { get: () => '/w' }
      if (key === 'loader') return { internal: { import: async () => ({ defineTool: (definition) => definition }) } }
      return services[key]
    },
    provide(key, value) {
      services[key] = value
    },
    inject(deps, callback) {
      const available = deps.every((dep) => deps.includes('connection') || services[dep] !== undefined || dep === 'tools' || dep === 'commands' || dep === 'skills' || dep === 'systemPrompt')
      if (!available) return
      /** @type {Record<string, any>} */
      const scope = { ...ctx }
      for (const dep of deps) scope[dep] = services[dep] ?? ctx[dep]
      callback(scope)
    },
    effect(fn) {
      effects.push(fn)
    },
    on(event, handler) {
      listeners[event] = [...(listeners[event] ?? []), handler]
    },
    tools: { register(tool) { registered.tools.push(tool) } },
    commands: { register(command) { registered.commands.push(command) } },
    skills: { register(skill) { registered.skills.push(skill) } },
    systemPrompt: { section(section) { registered.sections.push(section) } },
    connection: { fetch: { register(route) { routes.push(route) } } },
  }
  // Cordis throws on a direct access to a service the fiber never injected
  // (`cannot get property "x" without inject`). Reproduce that here so a
  // property access that kills the core row fails this test instead of the
  // user's first launch.
  return new Proxy(ctx, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)
      if (typeof prop === 'string' && /^[A-Za-z]/u.test(prop)) {
        throw new Error(`cannot get property "${prop}" without inject`)
      }
      return undefined
    },
  })
}

/**
 * Wait until a condition holds.
 * @param {() => boolean} check - condition.
 * @param {number} [timeoutMs] - budget.
 * @returns {Promise<void>} resolves when true.
 */
async function waitFor(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('the core row provides ctx.hnflow and ctx.capability, the page routes and the global command', async () => {
  const ctx = fakeContext()
  apply(ctx, { role: 'core' })
  assert.notEqual(ctx.services.hnflow, undefined)
  assert.notEqual(ctx.services.capability, undefined)
  // The row config must carry the capability keys through `resolveConfig`; a
  // missing `modelSelector` makes CapabilityService fall back to `additive`,
  // which puts the layer picker back into the left strip and leaves the native
  // model seat unshadowed.
  assert.equal(ctx.services.capability.modelSelector, 'replace')
  assert.equal(ctx.routes.length, 19)
  assert.ok(
    ctx.routes.some((route) => route.path === '/api/capability/prepare'),
    'the workspace prepare route is missing',
  )
  assert.equal(typeof ctx.services.hnflow.status, 'function')
  assert.equal(ctx.effects.length, 2)
  assert.deepEqual(ctx.registered.commands.map((command) => command.name), ['hnflow'])
  await ctx.services.hnflow.close()
})

test('the pass row only starts a ticker and never registers routes or tools', async () => {
  const ctx = fakeContext()
  apply(ctx, { role: 'core' })
  apply(ctx, { role: 'pass' })
  await waitFor(() => ctx.effects.length === 3)
  assert.equal(ctx.effects.length, 3)
  assert.equal(ctx.registered.tools.length, 0)
  assert.equal(ctx.registered.commands.length, 1)
  for (const dispose of ctx.effects) dispose()
  await ctx.services.hnflow.close()
})

test('the preset row registers the tools, skill and prompt section', async () => {
  const ctx = fakeContext()
  apply(ctx, { role: 'core' })
  apply(ctx, { role: 'preset' })
  await waitFor(() => ctx.registered.tools.length === 2 && ctx.registered.skills.length === 3)
  assert.deepEqual(ctx.registered.tools.map((tool) => tool.name), ['hnflow', 'hnflow_author'])
  // The `hnflow` command is global (core row); the capability row adds its own
  // two management commands inside the preset.
  assert.deepEqual(ctx.registered.commands.map((command) => command.name), ['hnflow', 'capability-agent', 'capability-layer'])
  // The preset row and the capability row register their skills concurrently,
  // so the arrival order is not part of the contract — only the set is.
  assert.deepEqual(ctx.registered.skills.map((skill) => skill.name).sort(), ['capability', 'hnflow-controls', 'hnflow-flows'])
  for (const skill of ctx.registered.skills) {
    assert.equal(skill.source, 'bundled')
    assert.equal(typeof skill.content, 'string')
    assert.ok(skill.content.length > 100)
  }
  assert.deepEqual(ctx.registered.sections.map((section) => section.name), ['hnflow:flows', 'capability:agent'])
  assert.equal(ctx.listeners['agent/pre-step'].length, 2)
  await ctx.services.hnflow.close()
})

test('the UI row and an unconfigured host row register nothing', async () => {
  const ctx = fakeContext()
  apply(ctx, { role: 'ui', host: false })
  assert.equal(ctx.services.hnflow, undefined)
  assert.equal(ctx.routes.length, 0)
  assert.equal(ctx.registered.commands.length, 0)
})

test('the config schema exists when schemastery resolves, and defaults are safe', () => {
  // Under plain Node the harness package is absent; the plugin must still load.
  assert.equal(Config === undefined || Config.type === 'object', true)
  const ctx = fakeContext()
  apply(ctx, {})
  // A preset row without a core service must not throw.
  assert.equal(ctx.routes.length, 0)
})
