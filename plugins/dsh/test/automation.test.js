/**
 * Automation primitives: cron, health, inbox staging, node kinds, channels,
 * the durable effect queue and trigger evaluation. Pure functions plus the two
 * filesystem-backed queues, exercised without a service.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createChannels } from '../lib/channels.js'
import { cronMatches, minuteBucket, parseCron } from '../lib/cron.js'
import { runHealth, STALL_MS } from '../lib/health.js'
import { pendingSummary, sortPending, stageOf, STAGES } from '../lib/inbox.js'
import { createKindRegistry, normalizeKindResult } from '../lib/kinds.js'
import { createOutbox } from '../lib/outbox.js'
import { evaluateTriggers, parseTriggers, readTriggers, runCompletedTriggers, triggersPath } from '../lib/triggers.js'

test('cron parses the five fields and rejects malformed expressions', () => {
  assert.equal(parseCron('*/5 * * * *').ok, true)
  assert.equal(parseCron('30 9 * * 1-5').ok, true)
  assert.equal(parseCron('0 0 1,15 * *').ok, true)
  for (const bad of ['', '* * * *', '* * * * * *', '60 * * * *', 'a * * * *', '*/0 * * * *', '5-1 * * * *']) {
    assert.equal(parseCron(bad).ok, false, bad)
  }
})

test('cron matches a specific minute and weekday', () => {
  const monday = new Date(2026, 0, 5, 9, 30)
  assert.equal(monday.getDay(), 1)
  assert.equal(cronMatches('30 9 * * 1-5', monday), true)
  assert.equal(cronMatches('30 9 * * 1-5', new Date(2026, 0, 5, 9, 31)), false)
  assert.equal(cronMatches('*/15 * * * *', new Date(2026, 0, 5, 9, 45)), true)
})

test('minuteBucket is a stable local minute key', () => {
  assert.equal(minuteBucket(new Date(2026, 0, 5, 9, 30, 59)), '2026-01-05T09:30')
  assert.equal(minuteBucket(new Date(2026, 0, 5, 9, 30, 1)), '2026-01-05T09:30')
})

test('health explains the state in one sentence', () => {
  const now = new Date('2026-01-05T10:00:00.000Z')
  const done = runHealth({ status: 'succeeded', endedAt: '2026-01-05T09:00:00.000Z' }, { now })
  assert.equal(done.code, 'ok')

  const failed = runHealth({ status: 'failed', error: { code: 'node-failed', message: 'boom' }, endedAt: '2026-01-05T09:00:00.000Z' }, { now })
  assert.equal(failed.code, 'node-failed')
  assert.match(failed.message, /boom/u)

  const waiting = runHealth(
    {
      status: 'waiting_human',
      pending: [{ id: 'p1', kind: 'request', nodeId: 'art', createdAt: '2026-01-05T09:00:00.000Z' }],
    },
    { now },
  )
  assert.equal(waiting.code, 'waiting-delivery')
  assert.equal(waiting.waitingOn, 'owner')

  const stale = runHealth({ status: 'running', updatedAt: new Date(now.getTime() - STALL_MS - 1000).toISOString(), nodes: { draft: { status: 'running' } } }, { now })
  assert.equal(stale.code, 'stalled')
  assert.match(stale.message, /秒没有进展/u)
})

test('inbox staging decides the order: rework, arbitration, decision, delivery', () => {
  const gate = { kind: 'gate', origin: 'decision', createdAt: '2026-01-01T00:00:03.000Z' }
  const arbitrate = { kind: 'gate', origin: 'inconclusive', createdAt: '2026-01-01T00:00:02.000Z' }
  const deliver = { kind: 'request', attempts: 0, createdAt: '2026-01-01T00:00:04.000Z' }
  const rework = { kind: 'request', attempts: 1, createdAt: '2026-01-01T00:00:01.000Z' }
  assert.equal(stageOf(gate).stage, 'decide')
  assert.equal(stageOf(arbitrate).stage, 'arbitrate')
  assert.equal(stageOf(deliver).stage, 'deliver')
  assert.equal(stageOf(rework).stage, 'rework')
  const sorted = sortPending([deliver, gate, rework, arbitrate].map((item) => ({ ...item, priority: stageOf(item).priority })))
  assert.deepEqual(sorted.map((item) => stageOf(item).stage), ['rework', 'arbitrate', 'decide', 'deliver'])
  assert.equal(STAGES.rework.priority < STAGES.deliver.priority, true)
  assert.match(pendingSummary(rework, { run: { flowName: '测试流程' } }), /退回/u)
})

test('kind registry refuses shadowing, duplicates and malformed kinds', () => {
  const registry = createKindRegistry()
  const stamp = registry.register({ id: 'stamp', title: '时间戳', run: async () => ({ status: 'done', output: { at: 1 } }) })
  assert.equal(stamp.id, 'stamp')
  assert.equal(registry.has('stamp'), true)
  assert.equal(registry.list().length, 1)
  assert.throws(() => registry.register({ id: 'agent', run: async () => ({}) }), /built in/u)
  assert.throws(() => registry.register({ id: 'stamp', run: async () => ({}) }), /already registered/u)
  assert.throws(() => registry.register({ id: 'Bad_Id', run: async () => ({}) }), /must match/u)
  assert.throws(() => registry.register({ id: 'norun' }), /needs a run/u)
  assert.equal(registry.unregister('stamp'), true)
})

test('a kind result is normalised into done or failed', () => {
  assert.deepEqual(normalizeKindResult({ status: 'done', output: { a: 1 } }, 'x'), { status: 'done', output: { a: 1 } })
  assert.equal(normalizeKindResult({ status: 'failed', diagnostic: { code: 'nope', message: 'm' } }, 'x').diagnostic.code, 'nope')
  assert.equal(normalizeKindResult({}, 'x').diagnostic.code, 'node-failed')
  assert.equal(normalizeKindResult(null, 'x').status, 'failed')
})

test('channels never throw and report unknown, disabled and failing transports', async () => {
  const channels = createChannels({ logger: {} })
  assert.deepEqual(channels.list().map((channel) => channel.id), ['inbox'])
  assert.equal((await channels.send('inbox', {})).ok, true)
  assert.equal((await channels.send('nope', {})).code, 'channel-unknown')
  channels.register({ id: 'feishu', title: '飞书', send: async () => {} })
  assert.equal((await channels.send('feishu', {})).ok, true)
  channels.register({ id: 'off', send: async () => {}, enabled: false })
  assert.equal((await channels.send('off', {})).code, 'channel-disabled')
  channels.register({ id: 'boom', send: async () => { throw new Error('no route') } })
  const failed = await channels.send('boom', {})
  assert.equal(failed.code, 'channel-failed')
  assert.match(failed.error, /no route/u)
  assert.throws(() => channels.register({ id: 'feishu', send: async () => {} }), /already registered/u)
})

test('the outbox is idempotent, backs off, and buries poison effects', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hnflow-outbox-'))
  let clock = new Date('2026-01-05T10:00:00.000Z')
  const outbox = createOutbox({ dir, now: () => clock, logger: {}, maxAttempts: 2 })
  await outbox.open()
  const first = await outbox.enqueue({ kind: 'notice', key: 'k1', payload: { a: 1 }, runId: 'run-1' })
  const second = await outbox.enqueue({ kind: 'notice', key: 'k1', payload: { a: 1 }, runId: 'run-1' })
  assert.equal(first.id, second.id)
  assert.equal(outbox.list().length, 1)
  assert.equal(outbox.due(clock).length, 1)

  await outbox.markFailed(first.id, 'temporary')
  assert.equal(outbox.due(clock).length, 0)
  clock = new Date(clock.getTime() + 5000)
  assert.equal(outbox.due(clock).length, 1)

  await outbox.markFailed(first.id, 'still broken')
  assert.equal(outbox.list()[0].status, 'dead')
  assert.equal(outbox.summary().dead, 1)
  // A later identical event is a new effect: dead entries stay buried and do
  // not block the next real occurrence.
  const again = await outbox.enqueue({ kind: 'notice', key: 'k1', payload: { a: 2 } })
  assert.notEqual(again.id, first.id)
  assert.equal(again.status, 'pending')
  assert.equal(outbox.list().length, 2)
})

test('trigger parsing collects errors instead of failing the file', () => {
  const parsed = parseTriggers({
    triggers: [
      { id: 'nightly', source: 'cron', cron: '0 2 * * *', flow: 'demo' },
      { id: 'bad-cron', source: 'cron', cron: 'nope', flow: 'demo' },
      { id: 'watch', source: 'file', watch: ['src/**/*.ts'], flow: 'demo' },
      { id: 'chain', source: 'run-completed', after: 'demo', flow: 'demo' },
      { id: 'nightly', source: 'cron', cron: '* * * * *', flow: 'demo' },
      { id: 'BAD', source: 'cron', cron: '* * * * *', flow: 'demo' },
    ],
  })
  assert.deepEqual(parsed.triggers.map((trigger) => trigger.id), ['nightly', 'watch', 'chain'])
  assert.equal(parsed.errors.length, 3)
  assert.equal(runCompletedTriggers(parsed.triggers, 'demo').length, 1)
  assert.equal(runCompletedTriggers(parsed.triggers, 'other').length, 0)
})

test('cron triggers fire once per minute and never twice', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'hnflow-trig-'))
  const triggers = parseTriggers({ triggers: [{ id: 'tick', source: 'cron', cron: '* * * * *', flow: 'demo' }] }).triggers
  const at = new Date(2026, 0, 5, 9, 30, 10)
  const first = await evaluateTriggers({ workspace, triggers, state: {}, now: at })
  assert.equal(first.fired.length, 1)
  assert.match(first.fired[0].key, /^tick:/u)
  const second = await evaluateTriggers({ workspace, triggers, state: first.state, now: new Date(2026, 0, 5, 9, 30, 40) })
  assert.equal(second.fired.length, 0)
  const next = await evaluateTriggers({ workspace, triggers, state: second.state, now: new Date(2026, 0, 5, 9, 31, 1) })
  assert.equal(next.fired.length, 1)
})

test('file triggers fire on a changed signature after the debounce', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'hnflow-trig-'))
  await mkdir(path.join(workspace, 'src'), { recursive: true })
  await writeFile(path.join(workspace, 'src', 'a.ts'), 'one', 'utf8')
  const triggers = parseTriggers({ triggers: [{ id: 'watch', source: 'file', watch: ['src/**/*.ts'], flow: 'demo', debounceMs: 0 }] }).triggers
  // The clock must be after the file's own mtime: a "settled" window in the
  // past would look like a file still being written.
  const at = new Date(Date.now() + 10_000)
  const first = await evaluateTriggers({ workspace, triggers, state: {}, now: at })
  assert.equal(first.fired.length, 1)
  const second = await evaluateTriggers({ workspace, triggers, state: first.state, now: new Date(at.getTime() + 1000) })
  assert.equal(second.fired.length, 0)
  await writeFile(path.join(workspace, 'src', 'a.ts'), 'two-two', 'utf8')
  const third = await evaluateTriggers({ workspace, triggers, state: second.state, now: new Date(at.getTime() + 5000) })
  assert.equal(third.fired.length, 1)
})

test('readTriggers reports a missing file and reads a real one', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'hnflow-trig-'))
  const config = { workspaceDir: '.hnflow' }
  assert.equal((await readTriggers(workspace, config)).missing, true)
  await mkdir(path.dirname(triggersPath(workspace, config)), { recursive: true })
  await writeFile(triggersPath(workspace, config), JSON.stringify({ triggers: [{ id: 'tick', source: 'cron', cron: '0 * * * *', flow: 'demo' }] }), 'utf8')
  const file = await readTriggers(workspace, config)
  assert.equal(file.missing, false)
  assert.equal(file.triggers.length, 1)
})
