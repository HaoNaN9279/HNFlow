/**
 * Shared fakes for the Node tests.
 *
 * The point is to exercise the real state machine — no HTTP, no DSH, no model —
 * while every seam the orchestrator touches is a plain object.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { resolveConfig } from '../lib/config.js'
import { createService } from '../lib/service.js'

/**
 * An in-memory stand-in for the durable store.
 * @returns {Record<string, any>} store.
 */
export function memoryStore() {
  /** @type {Map<string, Record<string, any>>} */
  const runs = new Map()
  return {
    mode: () => 'file',
    warnings: () => [],
    open: async () => {},
    close: async () => {},
    getRun: async (runId) => runs.get(runId) ?? null,
    listRuns: async () => [...runs.values()],
    putRun: async (run) => {
      runs.set(run.runId, JSON.parse(JSON.stringify(run)))
    },
    deleteRun: async (runId) => {
      runs.delete(runId)
    },
    /** Direct read used by assertions. */
    peek: (runId) => runs.get(runId) ?? null,
  }
}

/**
 * A VibeStack service fake with one layer (`strong`).
 * @param {{apiVersion?: number, layers?: Record<string, any>}} [options] - overrides.
 * @returns {Record<string, any>} service.
 */
export function fakeVibestack(options = {}) {
  const layers = options.layers ?? {
    strong: { id: 'strong', provider: 'deepseek-account', model: 'deepseek-pro', reasoningEffort: 'high' },
  }
  return {
    apiVersion: options.apiVersion ?? 2,
    listLayers: () => Object.values(layers),
    resolveLayer: (id) => layers[id],
    defaultLayer: () => 'strong',
    hasModel: (id) => layers[id] !== undefined,
    catalog: async () => ({ available: Object.values(layers), unroutable: [], error: undefined }),
  }
}

/**
 * A preset registry fake that knows `hnflow` and `standard`.
 * @returns {Record<string, any>} service.
 */
export function fakePresets() {
  return {
    resolve: async (id) => {
      if (id === 'hnflow' || id === 'standard') return { id }
      throw Object.assign(new Error(`Unknown agent preset: ${id}`), { code: 'agent-preset/not-found' })
    },
    compositionInventory: async () => [
      { id: 'hnflow', isDefault: false, rows: [{ entryId: 'preset-hnflow', moduleName: 'dsh-vibestack', enabled: true }] },
      { id: 'standard', isDefault: true, rows: [{ entryId: null, moduleName: 'dsh-agent-loop', enabled: true }] },
    ],
  }
}

/**
 * An agent registry fake: `get` answers the live host, `create` makes a conductor.
 * @param {{id?: string}} [options] - host identity.
 * @returns {Record<string, any>} service.
 */
export function fakeAgents(options = {}) {
  const host = { id: options.id ?? 'session-1', session: { id: options.id ?? 'session-1' } }
  return {
    host,
    get: (id) => (id === host.id ? host : undefined),
    create: async () => ({ agent: { id: 'conductor', session: { id: 'conductor' } }, dispose: async () => {} }),
  }
}

/**
 * A scripted subagent runner.
 *
 * `script[nodeId]` is an array of envelopes consumed in order; an `Error`
 * instance makes the spawn reject instead. Every call is recorded.
 * @param {Record<string, any[]>} script - per-node answers.
 * @returns {Record<string, any>} runner.
 */
export function fakeRunner(script = {}) {
  /** @type {Record<string, any>[]} */
  const calls = []
  const cursors = new Map()
  return {
    calls,
    available: () => true,
    spawn: async (input) => {
      const label = String(input.label)
      const nodeId = label.split('/').pop().split('#')[0]
      calls.push({ nodeId, preset: input.preset, agentOptions: input.agentOptions, prompt: input.prompt })
      const queue = script[nodeId] ?? script['*'] ?? []
      const index = cursors.get(nodeId) ?? 0
      cursors.set(nodeId, index + 1)
      const answer = queue[Math.min(index, queue.length - 1)]
      if (answer === undefined) throw Object.assign(new Error(`no scripted answer for ${nodeId}`), { code: 'no-script' })
      if (answer instanceof Error) throw answer
      const structured = typeof answer === 'function' ? answer(input) : answer
      return {
        childId: `child-${nodeId}-${index}`,
        result: Promise.resolve({ childId: `child-${nodeId}-${index}`, stopReason: 'completed', output: [], structured }),
        dispose: async () => {},
      }
    },
  }
}

/**
 * A runnable flow: one agent node feeding a terminal gate.
 * @returns {Record<string, any>} definition.
 */
export function gateFlow() {
  return {
    schemaVersion: 2,
    flow: { id: 'fl-test', name: '测试流程', description: 'agent → gate' },
    input: { type: 'object', required: ['brief'], properties: { brief: { type: 'string' } }, additionalProperties: false },
    nodes: [
      {
        id: 'draft',
        type: 'agent',
        preset: 'hnflow',
        instruction: '写要点：{{input.brief}}',
        input: { type: 'object', properties: { brief: { type: 'string' } } },
        output: { type: 'object', required: ['points'], properties: { points: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
      },
      { id: 'approve', type: 'gate', title: '确认' },
    ],
    edges: [{ id: 'e1', from: 'draft', to: 'approve', when: { kind: 'status', is: 'done' } }],
  }
}

/**
 * A flow with a human delivery and a verify node.
 * @returns {Record<string, any>} definition.
 */
export function deliveryFlow() {
  return {
    schemaVersion: 2,
    flow: { id: 'fl-deliver', name: '交付流程' },
    input: { type: 'object', properties: {}, additionalProperties: true },
    nodes: [
      {
        id: 'art',
        type: 'request',
        deliverable: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
        whyHuman: '需要真实美术判断',
      },
      { id: 'accept', type: 'verify', against: 'art', checks: ['schema'], onReject: { kind: 'return', maxAttempts: 2 } },
      {
        id: 'integrate',
        type: 'agent',
        preset: 'hnflow',
        instruction: '接入交付物：{{nodes.art.output}}',
        output: { type: 'object', required: ['changes'], properties: { changes: { type: 'array' } }, additionalProperties: false },
      },
    ],
    edges: [
      { id: 'e1', from: 'art', to: 'accept', when: { kind: 'status', is: 'done' } },
      { id: 'e2', from: 'accept', to: 'integrate', when: { kind: 'status', is: 'done' } },
    ],
  }
}

/**
 * Write a flow asset and a workspace reference into a fresh temp tree.
 * @param {Record<string, any>} definition - flow definition.
 * @param {{alias?: string, pinned?: number|null}} [options] - ref options.
 * @returns {Promise<{root: string, library: string, workspace: string, flowId: string}>} paths.
 */
export async function seedWorkspace(definition, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hnflow-test-'))
  const library = path.join(root, 'library')
  const workspace = path.join(root, 'ws')
  const flowId = String(definition.flow.id)
  const assetPath = path.join(library, `${flowId}.flow.json`)
  await mkdir(path.dirname(assetPath), { recursive: true })
  await writeFile(
    assetPath,
    `${JSON.stringify({
      asset: { id: flowId, name: definition.flow.name, description: 'test', revision: 1, tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      definition,
    }, null, 2)}\n`,
    'utf8',
  )
  await mkdir(path.join(workspace, '.hnflow'), { recursive: true })
  const snapshot = path.join(library, '.hnflow-revisions', flowId, 'r1.json')
  await mkdir(path.dirname(snapshot), { recursive: true })
  await writeFile(snapshot, `${JSON.stringify({ flowId, revision: 1, snapshotAt: new Date().toISOString(), definition }, null, 2)}\n`, 'utf8')
  await writeFile(
    path.join(workspace, '.hnflow', 'flows.json'),
    `${JSON.stringify({ version: 2, refs: [{ flowId, revision: options.pinned ?? null, alias: options.alias ?? 'demo', enabled: true }] }, null, 2)}\n`,
    'utf8',
  )
  return { root, library, workspace, flowId }
}

/**
 * Build a service over fakes.
 * @param {{script?: Record<string, any[]>, config?: Record<string, any>, store?: Record<string, any>, vibestack?: Record<string, any> | null, agents?: Record<string, any>}} [options] - overrides.
 * @returns {Promise<Record<string, any>>} service.
 */
export async function makeService(options = {}) {
  const config = resolveConfig({ role: 'core', ...(options.config ?? {}) })
  const store = options.store ?? memoryStore()
  const agents = options.agents ?? fakeAgents()
  const ctx = {
    storageDomain: undefined,
    get(key) {
      if (key === 'vibestack') return options.vibestack === undefined ? fakeVibestack() : options.vibestack
      if (key === 'agentPresets') return fakePresets()
      if (key === 'agents') return agents
      if (key === 'fs') return options.fs
      if (key === 'sessions') return options.sessions
      if (key === 'userQuestions') return options.questions
      return undefined
    },
  }
  const service = createService({ ctx, config, logger: {}, store, runner: options.runner ?? fakeRunner(options.script ?? {}), now: options.now })
  await service.open()
  return service
}
