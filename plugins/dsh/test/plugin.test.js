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
  return ctx
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

test('the core row provides ctx.hnflow and registers the page routes', async () => {
  const ctx = fakeContext()
  apply(ctx, { role: 'core' })
  assert.notEqual(ctx.services.hnflow, undefined)
  assert.equal(ctx.routes.length, 8)
  assert.equal(typeof ctx.services.hnflow.status, 'function')
  assert.equal(ctx.effects.length, 1)
  await ctx.services.hnflow.close()
})

test('the preset row registers the tools, command, skill and prompt section', async () => {
  const ctx = fakeContext()
  apply(ctx, { role: 'core' })
  apply(ctx, { role: 'preset' })
  await waitFor(() => ctx.registered.tools.length === 2 && ctx.registered.skills.length === 1)
  assert.deepEqual(ctx.registered.tools.map((tool) => tool.name), ['hnflow', 'hnflow_author'])
  assert.deepEqual(ctx.registered.commands.map((command) => command.name), ['hnflow'])
  assert.deepEqual(ctx.registered.skills.map((skill) => skill.name), ['hnflow-flows'])
  assert.deepEqual(ctx.registered.sections.map((section) => section.name), ['hnflow:flows'])
  assert.equal(ctx.listeners['agent/pre-step'].length, 1)
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
