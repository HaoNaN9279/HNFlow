/**
 * Contract: the bundled control skill must cover every model-facing action and
 * keep the human-only boundary explicit. The test reads the shipped Markdown,
 * so a new tool action cannot land without the skill following it.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { AUTHOR_ACTIONS } from '../lib/author.js'
import { readSkillFile } from '../lib/skill.js'
import { ACTIONS } from '../lib/tools.js'

const file = new URL('../skills/hnflow-controls/SKILL.md', import.meta.url)

test('the control skill is a bundled skill with a description', async () => {
  const skill = readSkillFile(await readFile(file, 'utf8'))
  assert.equal(skill.name, 'hnflow-controls')
  assert.ok(skill.description.length > 20)
  assert.ok(skill.content.length > 2000)
  assert.equal(skill.content.startsWith('---'), false)
})

test('the control skill names every hnflow and hnflow_author action', async () => {
  const { content } = readSkillFile(await readFile(file, 'utf8'))
  for (const action of ACTIONS) assert.ok(content.includes(`\`${action}\``), `hnflow action ${action} is missing`)
  for (const action of AUTHOR_ACTIONS) assert.ok(content.includes(`\`${action}\``), `hnflow_author action ${action} is missing`)
  assert.ok(content.includes('`hnflow`'))
  assert.ok(content.includes('`hnflow_author`'))
})

test('the control skill keeps gates and deliveries human-only and exposes no publish entry', async () => {
  const { content } = readSkillFile(await readFile(file, 'utf8'))
  assert.doesNotMatch(content, /`publish`/u)
  assert.doesNotMatch(content, /`rollback`/u)
  assert.match(content, /门禁/u)
  assert.match(content, /交付/u)
  assert.match(content, /只能由人完成/u)
  assert.match(content, /不要.*文件/u)
  assert.match(content, /直接改仓库文件/u)
})
