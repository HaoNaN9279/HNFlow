/**
 * Where the engine comes from.
 *
 * The plugin ships as an installed copy, so the checkout that owns the
 * virtualenv is not reachable through the bundle path; `/workflow doctor --save`
 * records it once and later starts read it back.
 */

import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { createWorkflowCommand } from '../lib/commands.js'
import { engineCwd, enginePointerPath, readEnginePointer, resolvePython } from '../lib/paths.js'

/**
 * A scratch DSH home with an engine record.
 * @param {string} name - unique suffix.
 * @param {Record<string, string>} record - pointer contents.
 * @returns {Promise<string>} the home directory.
 */
async function scratchHome(name, record) {
  const home = path.join(process.cwd(), 'temp', `doctor-${name}`)
  await rm(home, { recursive: true, force: true })
  await mkdir(path.join(home, 'hnflow'), { recursive: true })
  await writeFile(path.join(home, 'hnflow', 'engine.json'), JSON.stringify(record), 'utf8')
  return home
}

test('the recorded installation wins over the bundle-relative guess', async () => {
  const home = path.join(process.cwd(), 'temp', 'doctor-paths')
  await rm(home, { recursive: true, force: true })
  await mkdir(path.join(home, 'hnflow'), { recursive: true })
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await writeFile(enginePointerPath(), JSON.stringify({ python: process.execPath, cwd: home }), 'utf8')

    assert.equal(resolvePython({}), process.execPath)
    assert.equal(engineCwd({}), home)
    assert.deepEqual(readEnginePointer(), { python: process.execPath, cwd: home })

    // An explicit config still wins, so a profile can override the record.
    assert.equal(resolvePython({ enginePython: '/custom/python' }), '/custom/python')
  } finally {
    process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('a record pointing at a missing interpreter is ignored', async () => {
  const previous = process.env.DSH_HOME
  const home = await scratchHome('stale', { python: path.join(process.cwd(), 'temp', 'nope', 'python.exe'), cwd: process.cwd() })
  process.env.DSH_HOME = home
  try {
    const found = resolvePython({})
    assert.notEqual(found, path.join(process.cwd(), 'temp', 'nope', 'python.exe'))
  } finally {
    process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('the doctor reports the installation and can record a new one', async () => {
  const home = await scratchHome('report', {})
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const service = {
      config: { enginePython: '', engineCwd: '' },
      resetEngine: () => {
        resetCalls += 1
      },
    }
    let resetCalls = 0
    const command = createWorkflowCommand({ service, cwdOf: () => process.cwd() })

    const report = await command.handler({ rawInput: 'doctor', agent: {} })
    assert.equal(report.kind, 'success')
    assert.match(report.text, /engine installation/u)
    assert.match(report.text, /--save/u)

    const saved = await command.handler({ rawInput: `doctor --python "${process.execPath}" --cwd "${process.cwd()}" --save`, agent: {} })
    assert.equal(saved.kind, 'success')
    assert.equal(resetCalls, 1)
    assert.deepEqual(readEnginePointer(), { python: process.execPath, cwd: process.cwd() })

    const missing = await command.handler({ rawInput: 'doctor --python "D:\\nope\\python.exe" --save', agent: {} })
    assert.equal(missing.kind, 'error')
    assert.match(missing.text, /engine-python-missing/u)
  } finally {
    process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})
