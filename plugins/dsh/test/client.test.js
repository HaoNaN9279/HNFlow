/**
 * Client bundle contract: the module-loader factory, the two slot registrations
 * (sidebar rail entry + keyed main panel), and the pure helpers the page renders
 * with.
 *
 * There is no browser here, so the test loads the bundle with a minimal React
 * stand-in and a fake client context — enough to prove the registration shape
 * and that one `/workflow ui` command carries every payload.
 */

import { TextEncoder } from 'node:util'
import assert from 'node:assert/strict'
import test from 'node:test'

/** Minimal React/react-dom stand-ins (the bundle never renders in this test). */
const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
}
const reactDom = { createPortal: (node) => node }

/** Capture the loader registration from the bundle. */
let registration = null
globalThis.window = {
  __ModuleLoader__: {
    load: (spec) => {
      registration = spec
    },
  },
  innerHeight: 800,
}
globalThis.btoa = (value) => Buffer.from(value, 'binary').toString('base64')
globalThis.TextEncoder = globalThis.TextEncoder ?? TextEncoder

await import('../client.js?contract-test')

/**
 * The bundle exports as the loader would build them.
 * @returns {Record<string, any>} module exports.
 */
function loadBundle() {
  assert.notEqual(registration, null, 'the bundle must call __ModuleLoader__.load')
  return registration.factory((name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return reactDom
    throw new Error(`unexpected module ${name}`)
  })
}

/**
 * Apply the bundle to a fake client context.
 * @returns {{entries: Record<string, any>[], exports: Record<string, any>, injected: string[], ctx: Record<string, any>}} registrations and context.
 */
function applyBundle() {
  const exports = loadBundle()
  /** @type {Record<string, any>[]} */
  const entries = []
  /** @type {string[]} */
  const injected = []
  const ctx = {
    slots: {
      inject: (name, callback) => {
        injected.push(name)
        callback()
      },
      register: (entry, component) => {
        entries.push({ entry, component })
      },
    },
    remote: { commands: { execute: async () => ({ ok: true, text: '{}' }) } },
    inject: (deps, callback) => callback({}),
    effect: () => {},
  }
  exports.apply(ctx)
  return { entries, exports, injected, ctx }
}

test('the bundle registers the sidebar entry, the keyed main panel and the notice host', () => {
  const { entries, injected } = applyBundle()

  assert.equal(registration.id, 'dsh-hnflow')
  assert.equal(injected[0], 'sidebar.panellist')
  assert.equal(injected[1], 'main')
  assert.equal(injected.includes('shell.overlay'), true)

  const rail = entries[0]
  assert.equal(rail.entry.name, 'sidebar.panellist')
  assert.equal(rail.entry.id, 'hnflow')
  assert.equal(rail.entry.order, 15)
  assert.equal(rail.entry.label(), 'HNFlow')

  const page = entries[1]
  assert.equal(page.entry.name, 'main')
  // The layout matches the rail id to the main key.
  assert.equal(page.entry.key, rail.entry.id)
})

test('the session tab registers only for an HNFlow session', () => {
  const exports = loadBundle()

  /** @param {string} preset - projection value of the current session. */
  const run = (preset) => {
    const entries = []
    const ctx = {
      slots: { inject: (name, callback) => callback(), register: (entry) => entries.push(entry) },
      remote: { commands: { execute: async () => ({ ok: true, text: '{}' }) } },
      inject: (deps, callback) =>
        callback({
          uiSession: { adapter: { current: { getSnapshot: () => ({ key: 'session-1' }) } } },
          sessions: { list: { getSnapshot: () => ({ ids: ['session-1'], byId: { 'session-1': { projectionValues: { agentPreset: preset } } } }), subscribe: () => () => {} } },
        }),
      effect: () => {},
    }
    exports.apply(ctx)
    return entries
  }

  assert.equal(run('hnflow').some((entry) => entry.name === 'conversation.view'), true)
  assert.equal(run('vibestack').some((entry) => entry.name === 'conversation.view'), false)
})

test('the bundle no longer registers a composer entry', () => {
  const { injected } = applyBundle()
  assert.equal(injected.includes('conversation.input.left'), false)
})

test('the page inject face runs `/workflow ui` through remote.commands', async () => {
  const { entries, ctx } = applyBundle()
  /** @type {unknown[][]} */
  const calls = []
  ctx.inject = (deps, callback) => callback({ uiSession: { adapter: { current: { getSnapshot: () => ({ key: 'session-9' }) } } } })
  ctx.remote.commands.execute = async (...args) => {
    calls.push(args)
    return { ok: true, text: '{"runs":[],"tasks":[]}' }
  }

  const face = entries[1].entry.inject()
  const answer = await face.runUi('monitor', {})

  assert.deepEqual(answer, { runs: [], tasks: [] })
  assert.equal(calls.length, 1)
  const [sessionId, line] = calls[0]
  assert.equal(sessionId, 'session-9')
  assert.match(line, /^\/workflow ui monitor /u)
})

test('a failing ui command surfaces its coded error', async () => {
  const { entries, ctx } = applyBundle()
  ctx.inject = (deps, callback) => callback({})
  ctx.remote.commands.execute = async () => ({ ok: false, error: { code: 'ui-op', message: 'unknown ui op' } })

  const face = entries[1].entry.inject()
  await assert.rejects(face.runUi('nope', {}), (error) => /hnflow: ui-op: unknown ui op/u.test(error.message))
})

test('the bundle declares the services it consumes', () => {
  const exports = loadBundle()
  assert.deepEqual(exports.inject, ['slots', 'remote', 'remote.commands'])
})

test('the ui payload round-trips Windows paths and CJK', () => {
  const { internals } = loadBundle()
  const payload = { workspace: 'D:\\workspace\\HNFlow', key: '发布-公告' }
  const encoded = internals.encodePayload(payload)

  assert.equal(encoded.includes(' '), false)
  assert.equal(encoded.includes('\\'), false)
  const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  assert.deepEqual(decoded, payload)
})

test('a payload that is not an object is rejected', () => {
  const { internals } = loadBundle()
  assert.equal(internals.parseJson('not json'), null)
  assert.equal(internals.parseJson('[1,2]'), null)
  assert.deepEqual(internals.parseJson('{"a":1}'), { a: 1 })
})

test('the workspace snapshot maps to tree rows, skipping entries without a path', () => {
  const { internals } = loadBundle()
  const rows = internals.workspaceItems({
    items: [
      { workspaceId: 'w1', title: 'HNFlow', path: 'D:\\workspace\\HNFlow' },
      { workspaceId: 'w2', path: '' },
      { workspaceId: 'w3', path: 'D:\\tmp\\x' },
      null,
    ],
  })

  assert.deepEqual(rows, [
    { id: 'w1', name: 'HNFlow', path: 'D:\\workspace\\HNFlow' },
    { id: 'w3', name: 'D:\\tmp\\x', path: 'D:\\tmp\\x' },
  ])
})

test('the canvas uses stored positions and falls back to a grid', () => {
  const { internals } = loadBundle()
  const definition = {
    nodes: [
      { id: 'start', type: 'flow:start' },
      { id: 'end', type: 'flow:end' },
    ],
    edges: [{ source: 'start', source_port: 'out', target: 'end', target_port: 'in' }],
    metadata: { canvas: { positions: { start: { x: 40, y: 20 } } } },
  }

  const layout = internals.layoutDefinition(definition)

  assert.deepEqual(
    layout.nodes.map((node) => node.id),
    ['start', 'end'],
  )
  assert.ok(Math.abs(layout.nodes[0].x - (40 * 0.55 + 16)) < 0.001)
  assert.ok(layout.nodes[1].x > layout.nodes[0].x)
  assert.equal(layout.edges.length, 1)
  assert.match(layout.edges[0].path, /^M \d/u)
  assert.ok(layout.width > 0 && layout.height > 0)
})

test('an edge to a missing node is dropped instead of drawn', () => {
  const { internals } = loadBundle()
  const layout = internals.layoutDefinition({
    nodes: [{ id: 'start', type: 'flow:start' }],
    edges: [{ source: 'start', source_port: 'out', target: 'ghost', target_port: 'in' }],
  })
  assert.deepEqual(layout.edges, [])
})

test('an empty definition still produces a drawable box', () => {
  const { internals } = loadBundle()
  const layout = internals.layoutDefinition(null)
  assert.deepEqual(layout.nodes, [])
  assert.ok(layout.width > 0 && layout.height > 0)
})

test('the preset projection decides visibility in both shapes', () => {
  const { internals } = loadBundle()

  assert.equal(internals.isHnflowPreset('hnflow'), true)
  assert.equal(internals.isHnflowPreset('vibestack'), false)
  assert.equal(internals.isHnflowPreset({ id: 'hnflow' }), true)
  assert.equal(internals.isHnflowPreset({ id: 'standard' }), false)
  assert.equal(internals.isHnflowPreset(null), true)
  assert.equal(internals.isHnflowPreset(undefined), true)
})

test('only the first sighting of a pending task is announced', () => {
  const { internals } = loadBundle()
  const seen = new Set(['task-1'])

  const first = internals.freshTasks(seen, [{ taskId: 'task-1' }, { taskId: 'task-2' }, { taskId: 'task-3' }])
  assert.deepEqual(first.fresh.map((task) => task.taskId), ['task-2', 'task-3'])

  const again = internals.freshTasks(first.seen, [{ taskId: 'task-2' }, { taskId: 'task-3' }])
  assert.deepEqual(again.fresh, [])
  assert.equal(again.seen.has('task-2'), true)

  // A later, genuinely new task still announces.
  assert.deepEqual(internals.freshTasks(again.seen, [{ taskId: 'task-4' }]).fresh.map((task) => task.taskId), ['task-4'])
})

test('the right-bar tab type has the shape the registry validates', () => {
  const { internals } = loadBundle()
  const definition = internals.rightTabDefinition()

  assert.equal(definition.id, definition.kind)
  assert.equal(definition.priority, 'extension')
  assert.equal(typeof definition.title, 'function')
  assert.equal(definition.title(), 'HNFlow')
  // The start page lists `guide` entries; each one opens this type's kind, so
  // the entry opens the same three-tab page the rail entry opens.
  assert.equal(Array.isArray(definition.guide), true)
  assert.equal(definition.guide.length, 1)
  assert.equal(definition.guide[0].kind, definition.kind)
  assert.equal(definition.guide[0].title(), 'HNFlow')
  assert.equal(typeof definition.guide[0].description(), 'string')
})

test('labels stay compact in the monitor rows', () => {
  const { internals } = loadBundle()
  assert.equal(internals.shortPath('D:\\workspace\\HNFlow'), 'workspace/HNFlow')
  assert.equal(internals.shortPath(''), '—')
  assert.equal(internals.shortSession('session-bffb5087-60d4-48c1-a4c1-916ff797d3f1'), '…916ff797d3f1')
  assert.equal(internals.shortSession('short'), 'short')
  assert.equal(internals.shortSession(null), '—')
})
