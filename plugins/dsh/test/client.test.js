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
