/**
 * The CLI must be told which repository to read.
 *
 * `hnflow-stack` falls back to its own process cwd when neither `--repo` nor the
 * global config names a repository, and the host application's cwd is not the
 * HNFlow repository. Every call therefore pins `--repo` from the workspace (or
 * from this plugin's own package) and runs with `cwd` set to the project.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ensureStack, initArgs } from '../capability/lib/activate.js'
import { repoFor, resolveArgs, resolvePlan } from '../capability/lib/resolve.js'

test('repoFor prefers a repository above the workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hnflow-repo-'))
  try {
    await mkdir(path.join(root, 'capability-groups'), { recursive: true })
    const workspace = path.join(root, 'apps', 'demo')
    await mkdir(workspace, { recursive: true })
    assert.equal(repoFor(workspace), path.resolve(root))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('repoFor falls back to the repository this plugin ships from', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hnflow-norepo-'))
  try {
    const workspace = path.join(root, 'plain')
    await mkdir(workspace, { recursive: true })
    const repo = repoFor(workspace)
    assert.notEqual(repo, null)
    assert.equal(existsSync(path.join(repo, 'capability-groups')), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolveArgs pins --repo and --project ahead of the subcommand', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hnflow-args-'))
  try {
    await mkdir(path.join(root, 'capability-groups'), { recursive: true })
    const workspace = path.join(root, 'project')
    await mkdir(workspace, { recursive: true })
    const args = resolveArgs(workspace, { resolveMode: 'capabilities' })
    assert.deepEqual(args.slice(0, 4), ['--repo', path.resolve(root), '--project', workspace])
    assert.deepEqual(args.slice(4), ['resolve', '--json', '--mode', 'capabilities'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolveArgs uses project mode when configured', () => {
  const workspace = path.join(os.tmpdir(), 'hnflow-project-mode')
  const args = resolveArgs(workspace, { resolveMode: 'project' })
  assert.deepEqual(args.slice(-4), ['resolve', '--json', '--mode', 'project'])
  assert.equal(args[0], '--repo')
})

test('initArgs pins the repository and the project before init', () => {
  assert.deepEqual(initArgs('D:/work/proj', 'D:/repo'), [
    '--repo',
    'D:/repo',
    '--project',
    'D:/work/proj',
    'init',
  ])
  assert.deepEqual(initArgs('D:/work/proj'), ['--project', 'D:/work/proj', 'init'])
})

test('ensureStack initialises the workspace with the pinned repository', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hnflow-init-'))
  try {
    await mkdir(path.join(root, 'capability-groups'), { recursive: true })
    const workspace = path.join(root, 'project')
    await mkdir(workspace, { recursive: true })
    const calls = []
    const execute = async (command, args, options) => {
      calls.push({ command, args, options })
      await mkdir(path.join(workspace, '.hnflow'), { recursive: true })
      await writeFile(path.join(workspace, '.hnflow', 'stack.json'), '{"schema_version":2}\n', 'utf8')
      return { stdout: '', stderr: '' }
    }
    const result = await ensureStack(workspace, { timeoutMs: 1000, resolveMode: 'capabilities' }, execute)
    assert.equal(result.created, true)
    assert.equal(calls[0].options.cwd, workspace)
    assert.deepEqual(calls[0].args, [
      '--repo',
      path.resolve(root),
      '--project',
      workspace,
      'init',
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolvePlan runs the CLI inside the project and pins the repository', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hnflow-run-'))
  try {
    await mkdir(path.join(root, 'capability-groups'), { recursive: true })
    const workspace = path.join(root, 'project')
    await mkdir(workspace, { recursive: true })
    const calls = []
    const execute = async (command, args, options) => {
      calls.push({ command, args, options })
      return {
        stdout: JSON.stringify({ schema_version: 2, active: true, mode: 'capabilities', project: workspace }),
        stderr: '',
      }
    }
    const result = await resolvePlan(workspace, { resolveMode: 'capabilities', timeoutMs: 1000 }, execute)
    assert.equal(result.plan?.active, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].options.cwd, workspace)
    assert.deepEqual(calls[0].args.slice(0, 2), ['--repo', path.resolve(root)])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cliCandidates falls back to the launcher under the user home', async () => {
  const { cliCandidates } = await import('../capability/lib/resolve.js')
  const candidates = cliCandidates('')
  assert.ok(candidates.length >= 1)
  const suffix = process.platform === 'win32' ? 'hnflow-stack.exe' : 'hnflow-stack'
  assert.ok(candidates.some((entry) => entry === suffix || entry.endsWith(path.join('.local', 'bin', suffix))))
})
