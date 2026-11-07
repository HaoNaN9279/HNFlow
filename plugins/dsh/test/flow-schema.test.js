/**
 * The schema subset, value validation and contract assignability.
 *
 * These are the checks every publish relies on, so each rejection is asserted
 * by code and each acceptance by a positive example.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { assertObjectJsonSchema, isAssignable, validateValue } from '../lib/flow/schema.js'

test('the supported subset accepts the envelope-shaped schemas', () => {
  const schema = {
    type: 'object',
    required: ['status', 'output'],
    properties: {
      status: { const: 'done' },
      output: { type: 'object', properties: { points: { type: 'array', items: { type: 'string' } } } },
    },
    additionalProperties: false,
  }
  assert.equal(assertObjectJsonSchema(schema), schema)
})

test('unsupported keywords fail with schema-unsupported', () => {
  for (const extra of [{ $ref: '#/x' }, { anyOf: [] }, { patternProperties: {} }, { minimum: 1 }]) {
    assert.throws(
      () => assertObjectJsonSchema({ type: 'object', properties: { value: { type: 'string', ...extra } } }),
      (error) => error.code === 'schema-unsupported',
      JSON.stringify(extra),
    )
  }
})

test('a non-object top level is rejected', () => {
  assert.throws(() => assertObjectJsonSchema({ type: 'string' }), (error) => error.code === 'schema-unsupported')
  assert.throws(() => assertObjectJsonSchema([]), (error) => error.code === 'schema-invalid')
})

test('values are validated with paths and additionalProperties', () => {
  const schema = {
    type: 'object',
    required: ['points'],
    properties: { points: { type: 'array', items: { type: 'string' } } },
    additionalProperties: false,
  }
  assert.equal(validateValue({ points: ['a', 'b'] }, schema).ok, true)
  const missing = validateValue({}, schema)
  assert.equal(missing.ok, false)
  assert.equal(missing.violations[0].path, 'value.points')
  const extra = validateValue({ points: [], extra: 1 }, schema)
  assert.equal(extra.ok, false)
  assert.equal(extra.violations[0].path, 'value.extra')
  const wrong = validateValue({ points: [1] }, schema)
  assert.equal(wrong.ok, false)
  assert.equal(wrong.violations[0].path, 'value.points[0]')
})

test('oneOf requires exactly one branch', () => {
  const schema = { type: 'object', oneOf: [{ type: 'object', required: ['a'], properties: { a: { type: 'string' } } }, { type: 'object', required: ['b'], properties: { b: { type: 'string' } } }] }
  assert.equal(validateValue({ a: 'x' }, schema).ok, true)
  const both = validateValue({ a: 'x', b: 'y' }, schema)
  assert.equal(both.ok, false)
  assert.match(both.violations[0].actual, /2 matched/)
})

test('assignability follows required properties and types', () => {
  const produced = { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }
  const consumed = { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } } }
  assert.equal(isAssignable(produced, consumed).ok, true)
  assert.equal(isAssignable(consumed, produced).ok, true)
  const narrower = { type: 'object', required: ['files', 'notes'], properties: { files: { type: 'array' }, notes: { type: 'string' } } }
  const verdict = isAssignable(produced, narrower)
  assert.equal(verdict.ok, false)
  assert.match(verdict.violations[0].path, /notes/u)
})

test('assignability rejects a type mismatch', () => {
  const verdict = isAssignable({ type: 'object', properties: { x: { type: 'string' } } }, { type: 'object', properties: { x: { type: 'number' } } })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.violations[0].expected, 'number')
})
