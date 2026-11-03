/**
 * Client bundle contract: the module-loader factory, the slot registration, and
 * the command bridge the panel runs on.
 *
 * There is no browser here, so the test loads the bundle with a minimal React
 * stand-in and a fake client context — enough to prove the registration shape
 * and that every action goes through `remote.commands`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

/** Minimal React/react-dom stand-ins (the bundle never renders in this test). */
const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useRef: (initial) => ({ current: initial }),
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
 * @param {Record<string, any>} remote - `remote.commands.execute` result source.
 * @returns {{entry: Record<string, any>, exports: Record<string, any>}} the registration.
 */
function applyBundle(remote) {
  const exports = loadBundle()
  /** @type {Record<string, any>[]} */
  const registrations = []
  /** @type {string[]} */
  const injected = []
  const ctx = {
    slots: {
      inject: (name, callback) => {
        injected.push(name)
        callback()
      },
      register: (entry, component) => {
        registrations.push({ entry, component })
      },
    },
    remote: { commands: { execute: remote } },
    effect: () => {},
  }
  exports.apply(ctx)
  assert.deepEqual(injected, ['conversation.input.left'])
  assert.equal(registrations.length, 1)
  return { entry: registrations[0].entry, exports }
}

test('the bundle registers one composer-strip entry', () => {
  const { entry } = applyBundle(async () => ({ ok: true, text: 'x' }))
  assert.equal(registration.id, 'dsh-hnflow')
  assert.equal(entry.name, 'conversation.input.left')
  assert.equal(entry.id, 'hnflow-panel')
  assert.equal(entry.order, 6)
})

test('the inject face runs the command through remote.commands', async () => {
  /** @type {unknown[][]} */
  const calls = []
  const { entry } = applyBundle(async (...args) => {
    calls.push(args)
    return { ok: true, text: 'refs: publish' }
  })

  const face = entry.inject('session-1')
  assert.equal(await face.run('/workflow'), 'refs: publish')
  assert.deepEqual(calls[0], ['session-1', '/workflow', []])
})

test('a failing command surfaces its coded error', async () => {
  const { entry } = applyBundle(async () => ({ ok: false, error: { code: 'ref-missing', message: 'no workflow named x' } }))
  const face = entry.inject('session-1')

  await assert.rejects(face.run('/workflow run x'), (error) => error.message === 'hnflow: ref-missing: no workflow named x')
})

test('a result without a text field is shown as JSON', async () => {
  const { entry } = applyBundle(async () => ({ ok: true, value: { a: 1 } }))
  assert.equal(await entry.inject('session-1').run('/workflow'), '{"a":1}')
})

test('the bundle declares the services it consumes', () => {
  const exports = loadBundle()
  assert.deepEqual(exports.inject, ['slots', 'remote', 'remote.commands'])
})

test('the panel payload is parsed strictly', () => {
  const { internals } = loadBundle()
  assert.equal(internals.parsePanelPayload('not json'), null)
  assert.equal(internals.parsePanelPayload('{"selected":{}}'), null)

  const parsed = internals.parsePanelPayload(JSON.stringify({ workflows: [{ assetId: 'wf-1' }], selected: { key: 'publish', definition: { nodes: [] } } }))
  assert.equal(parsed.workflows.length, 1)
  assert.equal(parsed.selected.key, 'publish')
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
  // Stored x=40 → 40*0.55+16; the second node falls back to grid column 1.
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

  // The live projection is the preset id string, not an object.
  assert.equal(internals.isHnflowPreset('hnflow'), true)
  assert.equal(internals.isHnflowPreset('vibestack'), false)
  assert.equal(internals.isHnflowPreset('standard'), false)
  // The older object shape still works, and an unknown projection must not hide it.
  assert.equal(internals.isHnflowPreset({ id: 'hnflow' }), true)
  assert.equal(internals.isHnflowPreset({ id: 'standard' }), false)
  assert.equal(internals.isHnflowPreset(null), true)
  assert.equal(internals.isHnflowPreset(undefined), true)
})

test('the editor command carries the key, node, and raw JSON', () => {
  const { internals } = loadBundle()
  assert.equal(internals.nodeCommand('publish', 'greet', '{"value":"a  b"}'), '/workflow node publish greet {"value":"a  b"}')
})

test('writing back to the asset is a two-step command', () => {
  const { internals } = loadBundle()
  assert.equal(internals.saveAssetCommand('publish', false), '/workflow save asset publish')
  assert.equal(internals.saveAssetCommand('publish', true), '/workflow save asset publish --yes')
})

test('the inbox payload is parsed strictly', () => {
  const { internals } = loadBundle()
  assert.equal(internals.parseInbox('nope'), null)
  assert.equal(internals.parseInbox('{"tasks":"x"}'), null)

  const tasks = internals.parseInbox(JSON.stringify({ tasks: [{ taskId: 'task-1', kind: 'task' }, { nope: true }, 'x'] }))
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].taskId, 'task-1')
})

test('a task template matches the task kind', () => {
  const { internals } = loadBundle()

  assert.deepEqual(JSON.parse(internals.taskTemplate({ taskId: 't', kind: 'review' })), { decision: true, feedback: '' })
  assert.deepEqual(
    JSON.parse(internals.taskTemplate({ taskId: 't', kind: 'task', outputSpec: { ports: [{ name: 'note', type: 'data' }, { name: 'flag', type: 'bool' }] } })),
    { note: '', flag: false },
  )
})

test('submit carries the typed payload as JSON', () => {
  const { internals } = loadBundle()
  assert.equal(internals.submitCommand('task-1', '{"note":"a b"}'), '/workflow submit task-1 {"note":"a b"}')
})

test('the tab row has no duplicate ids or labels', () => {
  const { internals } = loadBundle()
  const rows = internals.menuItems()

  assert.deepEqual(
    rows.map((row) => row.label),
    ['工作流', '待办', '资产库'],
  )
  assert.equal(rows.filter((row) => row.kind === 'view').length, 2)
  // "待办" used to be both a view and an action, so the row showed it twice.
  assert.equal(new Set(rows.map((row) => row.label)).size, rows.length)
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length)
  assert.equal(rows[2].command, '/workflow asset list')
})

test('a repeated panel payload row is collapsed', () => {
  const { internals } = loadBundle()
  const payload = internals.parsePanelPayload(
    JSON.stringify({
      workflows: [
        { alias: 'publish', assetId: 'wf-1' },
        { alias: 'publish', assetId: 'wf-1' },
        { assetId: 'wf-2' },
        { assetId: 'wf-2' },
        null,
      ],
    }),
  )

  assert.deepEqual(
    payload.workflows.map((entry) => entry.alias || entry.assetId),
    ['publish', 'wf-2'],
  )
})

test('a repeated inbox task is collapsed', () => {
  const { internals } = loadBundle()
  const tasks = internals.parseInbox(JSON.stringify({ tasks: [{ taskId: 'task-1' }, { taskId: 'task-1' }, { taskId: 'task-2' }] }))
  assert.deepEqual(
    tasks.map((task) => task.taskId),
    ['task-1', 'task-2'],
  )
})

test('the popover opens above the trigger when there is room', () => {
  const { internals } = loadBundle()
  const placed = internals.placeMenu({ left: 120, top: 700, right: 200, bottom: 728 }, { width: 1200, height: 800 })

  assert.equal(placed.placement, 'above')
  assert.equal(placed.left, 120)
  // bottom edge sits `gap` pixels above the trigger top
  assert.equal(placed.bottom, 800 - 700 + 6)
  assert.ok(placed.maxHeight <= 420)
})

test('the popover flips below when the trigger is near the top', () => {
  const { internals } = loadBundle()
  const placed = internals.placeMenu({ left: 40, top: 30, right: 120, bottom: 58 }, { width: 1200, height: 800 })

  assert.equal(placed.placement, 'below')
  assert.equal(placed.top, 64)
  assert.ok(placed.maxHeight >= 120)
})

test('the popover stays inside a narrow viewport', () => {
  const { internals } = loadBundle()

  const rightEdge = internals.placeMenu({ left: 300, top: 600, right: 380, bottom: 628 }, { width: 400, height: 800 })
  assert.equal(rightEdge.left, 12) // 400 - width(380) - margin(8)
  assert.equal(rightEdge.width, 380)
  assert.ok(rightEdge.left >= 0)

  const narrow = internals.placeMenu({ left: 10, top: 600, right: 90, bottom: 628 }, { width: 260, height: 800 })
  assert.equal(narrow.width, 244) // 260 - 2 * 8
  assert.equal(narrow.left, 8)

  const tiny = internals.placeMenu({ left: 0, top: 20, right: 40, bottom: 48 }, { width: 200, height: 120 })
  assert.ok(tiny.left >= 0)
  assert.equal(tiny.width, 184) // 200 - 2 * 8
  assert.ok(tiny.maxHeight >= 120)
})

test('applying the same context twice registers one entry', () => {
  const exports = loadBundle()
  const registrations = []
  const ctx = {
    slots: {
      inject: (name, callback) => callback(),
      register: (entry, component) => registrations.push({ entry, component }),
    },
    remote: { commands: { execute: async () => ({ ok: true, text: '' }) } },
  }

  exports.apply(ctx)
  exports.apply(ctx)

  assert.equal(registrations.length, 1)
})
