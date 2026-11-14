/**
 * Shared fakes for the Node tests.
 *
 * The point is to exercise the real state machine — no HTTP, no DSH, no model —
 * while every seam the orchestrator touches is a plain object.
 */

import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
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
 * A Capability service fake shaped like apiVersion 3: four bound platform
 * layers, an optional catalog-only layer (`unbound`) and an optional DSH-only
 * layer (`custom`).
 * @param {{apiVersion?: number, layers?: Record<string, any>, unbound?: string[], custom?: Record<string, any>[], warnings?: string[]}} [options] - overrides.
 * @returns {Record<string, any>} service.
 */
export function fakeCapability(options = {}) {
  const layers = options.layers ?? {
    fast: { id: 'fast', provider: 'deepseek-account', model: 'deepseek-flash', kind: 'speed', rank: 1 },
    standard: { id: 'standard', provider: 'deepseek-account', model: 'deepseek-flash', kind: 'balanced', rank: 2 },
    strong: { id: 'strong', provider: 'deepseek-account', model: 'deepseek-pro', reasoningEffort: 'high', kind: 'reasoning', rank: 3 },
    vision: { id: 'vision', provider: 'deepseek-account', model: 'deepseek-flash', kind: 'multimodal', rank: 4 },
  }
  const unbound = options.unbound ?? []
  const custom = options.custom ?? []
  const warnings = options.warnings ?? []
  /** @returns {Record<string, any>[]} every catalog row, bound or not. */
  const rows = () => [
    ...Object.values(layers)
      .filter((layer) => !unbound.includes(layer.id))
      .map((layer) => ({ label: layer.id, description: '', kind: '', ...layer, bound: true, custom: false })),
    ...unbound.map((id, index) => ({ id, label: id, description: '', kind: '', rank: 100 + index, bound: false, custom: false })),
    ...custom.map((layer, index) => ({ label: layer.id, description: '', kind: 'custom', rank: 1000 + index, ...layer, bound: true, custom: true })),
  ]
  /** @param {string} id - layer id. @returns {Record<string, any> | undefined} bound copy. */
  const resolve = (id) => {
    const row = rows().find((entry) => entry.bound === true && entry.id === id)
    return row === undefined ? undefined : { ...row }
  }
  return {
    apiVersion: options.apiVersion ?? 3,
    listCatalog: () => rows(),
    listLayers: () => rows().filter((entry) => entry.bound === true),
    resolveLayer: resolve,
    hasLayer: (id) => rows().some((entry) => entry.id === id),
    defaultLayer: () => (layers.standard === undefined ? Object.keys(layers)[0] ?? null : 'standard'),
    hasModel: (id) => resolve(id) !== undefined,
    listWarnings: () => [...warnings],
    catalog: async () => ({ available: [], unroutable: [], error: undefined }),
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
      { id: 'hnflow', isDefault: false, rows: [{ entryId: 'preset-hnflow', moduleName: 'dsh-capability', enabled: true }] },
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
  const groupDir = path.join(workspace, '.hnflow', 'groups', 'team')
  await mkdir(path.join(groupDir, 'flows'), { recursive: true })
  await writeFile(path.join(groupDir, 'group.json'), `${JSON.stringify({ guid: '11111111111111111111111111111111', name: 'team', version: '', description: 'test group' }, null, 2)}\n`, 'utf8')
  await writeFile(path.join(workspace, '.hnflow', 'stack.json'), `${JSON.stringify({ schema_version: 2, core: { name: 'core', version: '0.1.0' }, groups: [{ name: 'team', version: '' }] }, null, 2)}\n`, 'utf8')
  await writeFile(path.join(groupDir, 'flows', 'demo.flow.json'), `${JSON.stringify(definition, null, 2)}\n`, 'utf8')
  return { root, library, workspace, flowId }
}

/**
 * Build a service over fakes.
 * @param {{script?: Record<string, any[]>, config?: Record<string, any>, store?: Record<string, any>, capability?: Record<string, any> | null, agents?: Record<string, any>}} [options] - overrides.
 * @returns {Promise<Record<string, any>>} service.
 */
export async function makeService(options = {}) {
  // Effects and trigger bookkeeping live under the state directory: give every
  // test its own temp one so runs in the suite cannot see each other's queue.
  const stateDir = options.config?.stateDir ?? (await mkdtemp(path.join(os.tmpdir(), 'hnflow-state-')))
  const config = resolveConfig({ role: 'core', ...(options.config ?? {}), stateDir })
  const store = options.store ?? memoryStore()
  const agents = options.agents ?? fakeAgents()
  const capability = options.capability === undefined ? fakeCapability() : options.capability
  if (capability !== null && typeof capability.planFor !== 'function') {
    capability.planFor = async (cwd) => {
      const groupsDir = path.join(cwd, '.hnflow', 'groups')
      const flows = []
      let groups = []
      try { groups = await readdir(groupsDir, { withFileTypes: true }) } catch { return { plan: { flows }, warnings: [] } }
      for (const group of groups.filter((entry) => entry.isDirectory())) {
        let files = []
        try { files = await readdir(path.join(groupsDir, group.name, 'flows')) } catch { continue }
        for (const file of files.filter((entry) => entry.endsWith('.flow.json'))) {
          const definition = JSON.parse(await readFile(path.join(groupsDir, group.name, 'flows', file), 'utf8'))
          const flowId = String(definition.flow?.id ?? file.replace(/\.flow\.json$/u, ''))
          flows.push({ id: `${group.name}/${flowId}`, flow_id: flowId, name: definition.flow?.name ?? flowId, path: path.join(groupsDir, group.name, 'flows', file), group: group.name, requires: [] })
        }
      }
      return { plan: { flows }, warnings: [] }
    }
  }
  const ctx = {
    storageDomain: undefined,
    get(key) {
      if (key === 'capability') return capability
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
