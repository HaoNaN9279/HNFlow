/**
 * Question cards for pending human tasks.
 *
 * The engine owns the task contract; this module must map both directions
 * exactly, because a wrong payload is a real submission, not a cancelled one.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { APPROVE_LABEL, REJECT_LABEL, questionsForTask } from '../lib/questions.js'

/**
 * A task summary shaped like the engine's `pendingTasks` entry.
 * @param {Record<string, any>} overrides - fields to replace.
 * @returns {Record<string, any>} task.
 */
function task(overrides = {}) {
  return {
    taskId: 'task-1',
    runId: 'run-1',
    nodeId: 'approve',
    kind: 'task',
    description: 'confirm the release',
    outputSpec: { ports: [] },
    ...overrides,
  }
}

test('a review asks approve or reject with a free-text reason', () => {
  const { questions, build } = questionsForTask(task({ kind: 'review', description: 'ship it?' }))

  assert.equal(questions.length, 1)
  assert.equal(questions[0].header, '人工审核')
  assert.deepEqual(
    questions[0].options.map((option) => option.label),
    [APPROVE_LABEL, REJECT_LABEL],
  )
  assert.deepEqual(build({ answers: [{ id: questions[0].id, selected: [APPROVE_LABEL] }] }), { decision: true, feedback: '' })
  assert.deepEqual(build({ answers: [{ id: questions[0].id, selected: [REJECT_LABEL], custom: 'missing changelog' }] }), { decision: false, feedback: 'missing changelog' })
})

test('an unanswered or unrecognised review submits nothing', () => {
  const { build } = questionsForTask(task({ kind: 'review' }))
  assert.equal(build({ answers: [] }), null)
  assert.equal(build({ answers: [{ id: 'x', selected: [] }] }), null)
})

test('task ports become one question each and coerce by type', () => {
  const { questions, build } = questionsForTask(
    task({
      outputSpec: {
        ports: [
          { name: 'note', type: 'data', required: true, description: '发布说明' },
          { name: 'count', type: 'number' },
          { name: 'flag', type: 'bool' },
        ],
      },
    }),
  )

  assert.deepEqual(
    questions.map((question) => question.header),
    ['note', 'count', 'flag'],
  )
  assert.deepEqual(
    questions[2].options.map((option) => option.label),
    ['true', 'false'],
  )

  const payload = build({
    answers: [
      { id: 'task-1:note', selected: ['done'] },
      { id: 'task-1:count', selected: ['3'] },
      { id: 'task-1:flag', selected: ['true'] },
    ],
  })
  assert.deepEqual(payload, { note: 'done', count: 3, flag: true })
})

test('JSON-shaped ports keep their structure and bad JSON stays a string', () => {
  const { build } = questionsForTask(task({ outputSpec: { ports: [{ name: 'payload', type: 'data' }, { name: 'tags', type: 'array' }] } }))
  const payload = build({
    answers: [
      { id: 'task-1:payload', selected: ['{"a":1}'] },
      { id: 'task-1:tags', selected: ['not json'] },
    ],
  })
  assert.deepEqual(payload.payload, { a: 1 })
  assert.equal(payload.tags, 'not json')
})

test('a missing required port blocks the submission', () => {
  const { build } = questionsForTask(task({ outputSpec: { ports: [{ name: 'note', type: 'data', required: true }] } }))
  assert.equal(build({ answers: [] }), null)
  assert.equal(build({ answers: [{ id: 'task-1:note', selected: [] }] }), null)
})

test('an optional port that is skipped is omitted from the payload', () => {
  const { build } = questionsForTask(task({ outputSpec: { ports: [{ name: 'note', type: 'data' }, { name: 'extra', type: 'data' }] } }))
  assert.deepEqual(build({ answers: [{ id: 'task-1:note', selected: ['ok'] }] }), { note: 'ok' })
})
