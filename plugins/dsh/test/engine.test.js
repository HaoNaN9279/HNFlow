/**
 * Engine client: framing, handshake, error mapping, notifications, crashes.
 *
 * The client is driven over an in-process fake pipe (`fixtures/fake-child.mjs`)
 * because the DSH Windows sandbox denies piped `spawn`; the Python side of the
 * same protocol is covered by `backend/tests/test_workflow_rpc.py`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { EngineClient, EngineError, PROTOCOL_VERSION } from '../lib/engine.js'
import { FakeChild, defaultResponder } from './fixtures/fake-child.mjs'

/**
 * A client wired to the fake pipe.
 * @param {{requestTimeoutMs?: number, responder?: Function}} [options] - overrides.
 * @returns {EngineClient} client.
 */
function makeClient(options = {}) {
  return new EngineClient({
    python: 'unused',
    command: ['fake-engine'],
    requestTimeoutMs: options.requestTimeoutMs ?? 2000,
    startupTimeoutMs: 5000,
    spawn: () => new FakeChild({ responder: options.responder }),
  })
}

test('handshake records the protocol version', async () => {
  const client = makeClient()
  try {
    const handshake = await client.ensureStarted()
    assert.equal(handshake.protocolVersion, PROTOCOL_VERSION)
    assert.equal(client.isRunning(), true)
    assert.deepEqual(await client.request('engine/ping'), { pong: true })
    assert.equal((await client.ensureStarted()).protocolVersion, PROTOCOL_VERSION)
  } finally {
    client.stop()
  }
})

test('engine errors keep their stable code', async () => {
  const client = makeClient()
  try {
    await client.ensureStarted()
    await assert.rejects(client.request('echo/fail'), (error) => error instanceof EngineError && error.code === 'boom' && error.message === 'nope')
  } finally {
    client.stop()
  }
})

test('notifications reach listeners before the response resolves', async () => {
  const client = makeClient()
  /** @type {Record<string, any>[]} */
  const seen = []
  const unsubscribe = client.onNotification((message) => seen.push(message))
  try {
    await client.ensureStarted()
    await client.request('echo/notify')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].method, 'run/status')
    assert.equal(seen[0].params.runId, 'run-1')
  } finally {
    unsubscribe()
    client.stop()
  }
})

test('a non-JSON line is skipped instead of breaking the session', async () => {
  const client = makeClient()
  try {
    await client.ensureStarted()
    assert.deepEqual(await client.request('echo/garbage'), { survived: true })
  } finally {
    client.stop()
  }
})

test('a slow engine trips the request timeout', async () => {
  const client = makeClient({ requestTimeoutMs: 80 })
  try {
    await client.ensureStarted()
    await assert.rejects(client.request('echo/slow'), (error) => error.code === 'engine-timeout')
  } finally {
    client.stop()
  }
})

test('an engine crash fails pending requests with engine-exited', async () => {
  const client = makeClient()
  try {
    await client.ensureStarted()
    await assert.rejects(client.request('echo/crash'), (error) => error.code === 'engine-exited' && error.data.exitCode === 3)
    assert.equal(client.isRunning(), false)
    await assert.rejects(client.request('engine/ping'), (error) => error.code === 'engine-not-started')
  } finally {
    client.stop()
  }
})

test('the handshake carries the model catalog', async () => {
  /** @type {Record<string, any>[]} */
  const seen = []
  const client = new EngineClient({
    python: 'unused',
    command: ['fake-engine'],
    startupTimeoutMs: 5000,
    models: [{ name: 'm1', use: 'deerflow.models.patched_deepseek:PatchedChatDeepSeek', model: 'm1' }],
    spawn: () =>
      new FakeChild({
        responder: (message, child) => {
          seen.push(message)
          defaultResponder(message, child)
        },
      }),
  })
  try {
    await client.ensureStarted()
    const initialize = seen.find((message) => message.method === 'engine/initialize')
    assert.equal(initialize.params.models.length, 1)
    assert.equal(initialize.params.models[0].name, 'm1')
  } finally {
    client.stop()
  }
})

test('requests before start are rejected instead of hanging', async () => {
  const client = makeClient()
  await assert.rejects(client.request('engine/ping'), (error) => error.code === 'engine-not-started')
})
