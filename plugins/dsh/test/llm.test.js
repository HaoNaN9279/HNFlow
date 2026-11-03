/**
 * Model bridge stage 2: AI nodes complete through the harness.
 *
 * The engine sends `llm/complete`; the plugin runs it on DSH's own LLM service
 * and returns assembled text. These tests cover the assembly and the routing;
 * the wire itself is covered by the engine-client request tests.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { llmAdapter } from '../index.js'
import { HnflowService } from '../lib/service.js'

/**
 * A fake client context exposing an LLM service.
 * @param {Record<string, any>} llm - service stand-in.
 * @returns {Record<string, any>} fake ctx.
 */
function ctxWith(llm) {
  return { get: (name) => (name === 'llm' ? llm : undefined) }
}

test('the adapter assembles a stream into one text answer', async () => {
  /** @type {Record<string, any>[]} */
  const requests = []
  const ctx = ctxWith({
    stream: async function* (request) {
      requests.push(request)
      yield { kind: 'text-delta', text: 'hello ' }
      yield { kind: 'text-delta', text: 'world' }
      yield { kind: 'finish', failure: null }
    },
  })

  const adapter = llmAdapter(ctx)
  const result = await adapter.complete({ provider: 'deepseek', model: 'deepseek-flash', messages: [{ role: 'system', text: 'be brief' }, { role: 'user', text: 'hi' }] })

  assert.deepEqual(result, { text: 'hello world' })
  assert.equal(requests[0].provider, 'deepseek')
  assert.equal(requests[0].model, 'deepseek-flash')
  assert.deepEqual(requests[0].messages, [
    { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ])
})

test('the adapter forwards a failure code instead of a partial answer', async () => {
  const ctx = ctxWith({
    stream: async function* () {
      yield { kind: 'text-delta', text: 'half' }
      yield { kind: 'finish', failure: { code: 'AUTH', message: 'bad key' } }
    },
  })

  await assert.rejects(llmAdapter(ctx).complete({ model: 'm', messages: [] }), (error) => error.code === 'AUTH' && error.message === 'bad key')
})

test('the adapter refuses when the session has no LLM service', async () => {
  await assert.rejects(llmAdapter(ctxWith(undefined)).complete({ model: 'm', messages: [] }), (error) => error.code === 'llm-unavailable')
})

test('the service registers the completion handler on its engine', async () => {
  /** @type {Map<string, Function>} */
  const handlers = new Map()
  const engine = {
    onRequest: (method, handler) => handlers.set(method, handler),
    request: async () => ({}),
    stop: () => {},
  }
  const service = new HnflowService({ engine, llm: { complete: async (payload) => ({ text: `answered:${payload.model}` }) } })

  const handler = handlers.get('llm/complete')
  assert.equal(typeof handler, 'function')
  assert.deepEqual(await handler({ model: 'm' }), { text: 'answered:m' })
  assert.equal(service.llm !== null, true)
})

test('the handler fails loudly without an LLM adapter', async () => {
  /** @type {Function | null} */
  let handler = null
  const service = new HnflowService({
    engine: {
      onRequest: (_method, registered) => {
        handler = registered
      },
      request: async () => ({}),
      stop: () => {},
    },
  })

  assert.equal(service.llm, null)
  await assert.rejects(handler({ model: 'm' }), (error) => error.code === 'llm-unavailable')
})

test('an engine without onRequest is tolerated', () => {
  const service = new HnflowService({ engine: { request: async () => ({}), stop: () => {} } })
  assert.equal(service.disposed, false)
  service.dispose()
  assert.equal(service.disposed, true)
})
