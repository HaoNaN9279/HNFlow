/**
 * Scheduler semantics: readiness, edge conditions, skip/block, fallback.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { activateFallbacks, edgeTaken, impliedStatus, runnableNodes, settle } from '../lib/scheduler.js'

/**
 * A linear flow.
 * @returns {Record<string, any>} definition.
 */
function linear() {
  return {
    flow: { id: 'f', name: 'f' },
    nodes: [
      { id: 'a', type: 'agent' },
      { id: 'b', type: 'agent' },
    ],
    edges: [{ id: 'e1', from: 'a', to: 'b', when: { kind: 'status', is: 'done' } }],
  }
}

/**
 * A fresh run over a flow.
 * @param {Record<string, any>} flow - definition.
 * @returns {Record<string, any>} run.
 */
function freshRun(flow) {
  return { runId: 'r', nodes: Object.fromEntries(flow.nodes.map((node) => [node.id, { status: 'pending', attempts: 0 }])), pending: [] }
}

test('the start node runs first, then the edge decides', () => {
  const flow = linear()
  const run = freshRun(flow)
  assert.deepEqual(runnableNodes(flow, run), ['a'])
  run.nodes.a = { status: 'done', output: {} }
  assert.deepEqual(runnableNodes(flow, run), ['b'])
})

test('edge conditions map node state to an outcome', () => {
  const run = { nodes: { a: { status: 'done', verdict: 'accept', output: { decision: 'approved', accepted: true } } } }
  assert.equal(edgeTaken({ from: 'a', when: { kind: 'status', is: 'done' } }, run), true)
  assert.equal(edgeTaken({ from: 'a', when: { kind: 'status', is: 'failed' } }, run), false)
  assert.equal(edgeTaken({ from: 'a', when: { kind: 'verdict', is: 'accept' } }, run), true)
  assert.equal(edgeTaken({ from: 'a', when: { kind: 'gate', is: 'approved' } }, run), true)
  assert.equal(edgeTaken({ from: 'a', when: { kind: 'artifact.accepted', is: true } }, run), true)
  assert.equal(edgeTaken({ from: 'a', when: { kind: 'always' } }, run), true)
})

test('an undecided predecessor keeps an edge open', () => {
  assert.equal(edgeTaken({ from: 'a', when: { kind: 'status', is: 'done' } }, { nodes: { a: { status: 'running' } } }), null)
})

test('a settled branch that was not taken skips its node', () => {
  const flow = {
    flow: { id: 'f', name: 'f' },
    nodes: [
      { id: 'a', type: 'gate' },
      { id: 'b', type: 'agent' },
      { id: 'c', type: 'agent' },
    ],
    edges: [
      { id: 'e1', from: 'a', to: 'b', when: { kind: 'gate', is: 'approved' } },
      { id: 'e2', from: 'a', to: 'c', when: { kind: 'gate', is: 'rejected' } },
    ],
  }
  const run = freshRun(flow)
  run.nodes.a = { status: 'done', output: { decision: 'approved' } }
  const result = settle(flow, run)
  assert.deepEqual(result.skipped, ['c'])
  assert.equal(run.nodes.c.status, 'skipped')
  assert.deepEqual(runnableNodes(flow, run), ['b'])
})

test('a blocked failure blocks the downstream node', () => {
  const flow = linear()
  const run = freshRun(flow)
  run.nodes.a = { status: 'failed', diagnostic: { code: 'x' } }
  const result = settle(flow, run)
  assert.deepEqual(result.blocked, ['b'])
  assert.equal(run.nodes.b.status, 'blocked')
  assert.deepEqual(runnableNodes(flow, run), [])
  assert.equal(impliedStatus(flow, run), 'failed')
})

test('a skip policy lets the rest of the run finish', () => {
  const flow = linear()
  flow.edges[0].onFail = { kind: 'skip' }
  const run = freshRun(flow)
  run.nodes.a = { status: 'failed' }
  settle(flow, run)
  assert.equal(run.nodes.b.status, 'skipped')
  assert.equal(impliedStatus(flow, run), 'failed')
})

test('a fallback node is activated even without a taken edge', () => {
  const flow = linear()
  flow.nodes.push({ id: 'alt', type: 'agent' })
  flow.edges[0].onFail = { kind: 'fallback', node: 'alt' }
  const run = freshRun(flow)
  run.nodes.a = { status: 'failed' }
  const activated = activateFallbacks(flow, run, 'a')
  assert.deepEqual(activated, ['alt'])
  assert.equal(runnableNodes(flow, run).includes('alt'), true)
})

test('implied status reflects waiting and running nodes', () => {
  const flow = linear()
  const run = freshRun(flow)
  assert.equal(impliedStatus(flow, run), 'running')
  run.nodes.b = { status: 'waiting' }
  assert.equal(impliedStatus(flow, run), 'waiting_human')
  run.nodes.a = { status: 'done' }
  run.nodes.b = { status: 'done' }
  assert.equal(impliedStatus(flow, run), 'succeeded')
})
