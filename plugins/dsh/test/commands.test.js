/**
 * `/workflow`: one reference, one prompt, one AI turn — and nothing else.
 *
 * The properties pinned here are the ones the product decision rests on: the
 * command never starts a run itself, it only resolves a name the workspace
 * actually references, and the person's prompt reaches the model verbatim.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { USAGE, composeWorkflowPrompt, createWorkflowCommand, tokenize } from '../lib/commands.js'

/**
 * Build the command over a scripted service.
 * @param {Record<string, any>} [overrides] - service methods to replace.
 * @returns {{handler: Function, turns: {agent: unknown, text: string}[], calls: Record<string, any>[], primed: string[]}} command and call log.
 */
function makeCommand(overrides = {}) {
  /** @type {{agent: unknown, text: string}[]} */
  const turns = []
  /** @type {Record<string, any>[]} */
  const calls = []
  /** @type {string[]} */
  const primed = []
  const base = {
    listWorkflows: async () => [
      { alias: 'publish', assetId: 'wf-1', description: '发布', pinnedRevision: 3, currentRevision: 3, hasOverride: false, drift: false, enabled: true, missing: false },
    ],
    resolve: async (_cwd, key) => {
      calls.push({ method: 'resolve', key })
      if (key !== 'publish') {
        const error = new Error(`no workflow named ${key} in this workspace`)
        error.code = 'ref-missing'
        throw error
      }
      return { key, alias: 'publish', assetId: 'wf-1', assetName: '发布', definition: { nodes: [], edges: [] }, source: 'ref', revision: 3, currentRevision: 4, drift: true }
    },
    ...overrides,
  }
  const agent = { session: { id: 'session-1' } }
  const command = createWorkflowCommand({
    service: base,
    cwdOf: () => '/ws',
    startTurn: async (target, text) => {
      turns.push({ agent: target, text })
    },
    primeIndex: async (cwd) => {
      primed.push(cwd)
    },
  })
  return { handler: (invocation) => command.handler({ agent, ...invocation }), turns, calls, primed }
}

test('tokenize honours quotes and collapses whitespace', () => {
  assert.deepEqual(tokenize('  "publish flow" a=1 '), ['publish flow', 'a=1'])
  assert.deepEqual(tokenize(''), [])
})

test('bare /workflow lists the workspace refs and the usage', async () => {
  const { handler, turns } = makeCommand()
  const result = await handler({ rawInput: '' })

  assert.equal(result.kind, 'success')
  assert.match(result.text, /- publish \(wf-1/u)
  assert.match(result.text, /\/workflow <name> <prompt>/u)
  assert.equal(turns.length, 0)
})

test('help is the same answer and starts no turn', async () => {
  const { handler, turns } = makeCommand()
  const result = await handler({ rawInput: 'help' })

  assert.equal(result.text.startsWith(USAGE), true)
  assert.equal(turns.length, 0)
})

test('a reference plus a prompt becomes exactly one AI turn', async () => {
  const { handler, turns, calls, primed } = makeCommand()
  const result = await handler({ rawInput: 'publish 把 staging 的构建产物发布出去，注意版本号' })

  assert.equal(result.kind, 'success')
  assert.match(result.text, /已交给 AI：publish（wf-1，r3）/u)
  assert.deepEqual(calls, [{ method: 'resolve', key: 'publish' }])
  // The index is primed before the turn, so a first turn already carries it.
  assert.deepEqual(primed, ['/ws'])
  assert.equal(turns.length, 1)
  assert.equal(turns[0].agent.session.id, 'session-1')
  assert.match(turns[0].text, /^<hnflow_workflow name="publish" asset="wf-1" revision="3" source="ref" \/>/u)
  assert.match(turns[0].text, /把 staging 的构建产物发布出去，注意版本号/u)
})

test('the prompt is preserved verbatim, including quotes and newlines', async () => {
  const { handler, turns } = makeCommand()
  await handler({ rawInput: 'publish 第一行\n第二行 "带 空格" 的文本' })

  assert.match(turns[0].text, /第一行\n第二行 "带 空格" 的文本$/u)
})

test('a name the workspace does not reference is refused before any turn', async () => {
  const { handler, turns } = makeCommand()
  const result = await handler({ rawInput: 'release 帮我发布' })

  assert.equal(result.kind, 'error')
  assert.match(result.text, /ref-missing/u)
  assert.match(result.text, /本工作区没有引用名叫 release 的工作流/u)
  assert.match(result.text, /- publish \(wf-1/u)
  assert.equal(turns.length, 0)
})

test('a reference without a prompt asks for one instead of starting a turn', async () => {
  const { handler, turns } = makeCommand()
  const result = await handler({ rawInput: 'publish' })

  assert.equal(result.kind, 'error')
  assert.match(result.text, /usage: \/workflow publish <提示词>/u)
  assert.equal(turns.length, 0)
})

test('a session that cannot start a turn reports it instead of throwing', async () => {
  const command = createWorkflowCommand({
    service: {
      listWorkflows: async () => [],
      resolve: async (_cwd, key) => ({ key, assetId: 'wf-1', source: 'override', revision: 2, currentRevision: 2 }),
    },
    cwdOf: () => '/ws',
    startTurn: async () => {
      throw Object.assign(new Error('this session cannot accept a new turn'), { code: 'turn-unavailable' })
    },
  })
  const result = await command.handler({ agent: {}, rawInput: 'publish 去做' })

  assert.equal(result.kind, 'error')
  assert.equal(result.text, 'workflow: turn-unavailable: this session cannot accept a new turn')
})

test('a session without a workspace is told so', async () => {
  const command = createWorkflowCommand({ service: {}, cwdOf: () => null, startTurn: async () => {} })
  const result = await command.handler({ rawInput: 'publish 去做' })

  assert.equal(result.kind, 'error')
  assert.match(result.text, /no workspace directory/u)
})

test('the composed prompt quotes the tag attributes', () => {
  const text = composeWorkflowPrompt({ key: 'a"<b>', assetId: 'wf-1', revision: null, source: 'override' }, 'go')
  assert.equal(text, '<hnflow_workflow name="a&quot;&lt;b&gt;" asset="wf-1" source="override" />\n\ngo')
})
