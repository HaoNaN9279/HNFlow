/**
 * The `hnflow` preset is a Cordis entry list copied from the shipped standard
 * preset, so it drifts whenever DSH renames or retires one of those entries.
 *
 * A child that no longer resolves does not fail loudly: `mountPreset` throws,
 * the registry marks the preset `broken`, and the new-session mode picker only
 * offers healthy presets — HNFlow silently disappears from the picker while the
 * Loader row still reports `active`. This test reads the bundle patch, pins the
 * structural invariants, and (when an installed DSH is reachable) resolves every
 * module specifier against its package's `exports` map.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const patchPath = path.join(root, 'cordis.patch.yml')
const patch = readFileSync(patchPath, 'utf8')

/**
 * Collect the preset's child entries from the bundle patch.
 *
 * The patch is a small, hand-written YAML file: every child is an `- id:`
 * line followed by its `name:` line, and groups nest more children under
 * `config:`. Scanning the whole `preset-hnflow` row therefore collects both
 * the direct children and the nested ones.
 *
 * @returns {{ id: string, name: string }[]} preset child entries, document order.
 */
function presetChildren() {
  const lines = patch.split(/\r?\n/)
  const start = lines.findIndex((line) => /^\s*-\s+id:\s*preset-hnflow\s*$/u.test(line))
  assert.notEqual(start, -1, 'cordis.patch.yml no longer declares the preset-hnflow row')
  const anchor = lines[start].match(/^(\s*)/u)[1].length
  /** @type {{ id: string, name: string }[]} */
  const children = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    const id = line.match(/^(\s*)-\s+id:\s*(\S+)\s*$/u)
    if (id === null) continue
    // A row at the anchor indent starts the next Loader row: the preset is over.
    if (id[1].length <= anchor) break
    const nameLine = lines.slice(index + 1).find((next) => /^\s*name:\s*\S/u.test(next))
    assert.notEqual(nameLine, undefined, `entry "${id[2]}" has no name`)
    children.push({ id: id[2], name: nameLine.match(/^\s*name:\s*(.+)$/u)[1].replace(/^['"]|['"]$/gu, '') })
  }
  return children
}

test('the preset children are uniquely identified and every entry names a module', () => {
  const children = presetChildren()
  assert.ok(children.length > 10, 'the preset lost its child list')
  const ids = children.map((child) => child.id)
  assert.equal(new Set(ids).size, ids.length, `duplicate preset child id: ${ids.join(', ')}`)
  for (const child of children) {
    assert.ok(child.name.length > 0, `entry "${child.id}" has an empty name`)
    assert.doesNotMatch(child.id, /\s/u, `entry id "${child.id}" contains whitespace`)
  }
  // The HNFlow bundle's own rows stay in the list: the preset composes the
  // capability surface and the host half from this plugin.
  assert.ok(ids.includes('hnflow'), 'the preset no longer mounts dsh-hnflow itself')
})

test('the preset does not reference the retired list-agents subpath', () => {
  const names = presetChildren().map((child) => child.name)
  // 0.2.2 moved `list_agents` into dsh-tool-subagent-control itself; the
  // `dsh-tool-subagent-control/list-agents` specifier no longer resolves and
  // made the whole preset broken.
  assert.equal(names.includes('@deepseek-ai/dsh-tool-subagent-control/list-agents'), false)
})

/**
 * Candidate `node_modules` roots of an installed DSH.
 *
 * @returns {string[]} directories that may hold the `@deepseek-ai` packages.
 */
function installRoots() {
  /** @type {string[]} */
  const roots = []
  const install = process.env.DSH_INSTALL_DIR
  if (install !== undefined && install.length > 0) {
    // .../node_modules/@deepseek-ai/dsh → .../node_modules
    roots.push(path.resolve(install, '..', '..'))
  }
  const profile = process.env.DSH_PROFILE_DIR
  if (profile !== undefined && profile.length > 0) roots.push(path.join(profile, 'node_modules'))
  return roots.filter((candidate) => existsSync(path.join(candidate, '@deepseek-ai')))
}

/**
 * Resolve a module specifier to a file through the package `exports` map.
 *
 * @param {string[]} roots - candidate node_modules roots.
 * @param {string} specifier - `@scope/pkg/subpath` or `pkg`.
 * @returns {string | null} absolute file path, or null when the package is absent.
 */
function resolveSpecifier(roots, specifier) {
  const parts = specifier.split('/')
  const pkg = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  const subpath = parts.slice(specifier.startsWith('@') ? 2 : 1).join('/')
  for (const root of roots) {
    const directory = path.join(root, ...pkg.split('/'))
    const manifestPath = path.join(directory, 'package.json')
    if (!existsSync(manifestPath)) continue
    /** @type {Record<string, any>} */
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const exports = manifest.exports
    /** @type {string | null} */
    let target = null
    if (exports === undefined || typeof exports === 'string') {
      target = exports ?? manifest.module ?? manifest.main ?? null
    } else {
      const key = subpath.length === 0 ? '.' : `./${subpath}`
      const entry = exports[key] ?? (subpath.length === 0 ? exports['.'] : undefined)
      if (typeof entry === 'string') target = entry
      else if (entry !== undefined) target = entry.default ?? entry.import ?? entry.require ?? null
    }
    return target === null ? null : path.resolve(directory, target)
  }
  return null
}

test('every preset child resolves against the installed DSH', { skip: installRoots().length === 0 ? 'no DSH install on this machine' : false }, () => {
  const roots = installRoots()
  /** @type {string[]} */
  const failures = []
  for (const child of presetChildren()) {
    // Groups and the bundle's own plugin are not installed modules.
    if (child.name.startsWith('cordis:')) continue
    if (child.name === 'dsh-hnflow') continue
    const file = resolveSpecifier(roots, child.name)
    if (file === null) failures.push(`${child.id}: ${child.name} (package missing)`)
    else if (!existsSync(file)) failures.push(`${child.id}: ${child.name} → ${file} (file missing)`)
  }
  assert.deepEqual(failures, [], 'preset children that no longer resolve; the preset would mount broken and vanish from the mode picker')
})
