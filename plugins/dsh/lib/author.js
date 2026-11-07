/**
 * The `hnflow_author` tool: schema, validation and drafting.
 *
 * Deliberately missing: publish. A draft is a workspace override, which a run
 * may read but which never advances an asset revision — only `publish` does,
 * and it exists on the human command and page surfaces. I1 is therefore a
 * physical property of this file, not a promise.
 */

import { definitionProblems } from './assets.js'
import { EDGE_WHEN_KINDS, GATE_DECISIONS, NODE_TYPES } from './flow/definition.js'

/** Shape reference returned by the `schema` action. */
export const FLOW_SCHEMA_REFERENCE = Object.freeze({
  schemaVersion: 2,
  flow: { id: 'fl-…', name: '示例流程', description: '一句话说明', tags: ['demo'] },
  input: { type: 'object', properties: { brief: { type: 'string' } }, required: ['brief'], additionalProperties: false },
  nodes: [
    {
      id: 'concept',
      type: 'agent',
      preset: 'hnflow',
      model: '可选：VibeStack 模型层 id',
      instruction: '根据 {{input.brief}} 产出 3 个方向。',
      input: { type: 'object', properties: { brief: { type: 'string' } } },
      output: {
        type: 'object',
        required: ['directions'],
        properties: { directions: { type: 'array', items: { type: 'object' } } },
        additionalProperties: false,
      },
      budget: { maxAttempts: 2, timeoutMs: 900000 },
    },
    { id: 'review', type: 'gate', title: '人工评审', detail: '确认概念方向', options: ['通过', '重做'] },
    {
      id: 'art',
      type: 'request',
      deliverable: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } } },
      whyHuman: '精修需要真实美术判断',
      deadline: { hours: 72 },
      onExpire: 'remind',
    },
    { id: 'accept', type: 'verify', against: 'art', checks: ['schema'], onReject: { kind: 'return', maxAttempts: 2 } },
    {
      id: 'integrate',
      type: 'agent',
      preset: 'hnflow',
      instruction: '接入通过验收的交付物。',
      output: { type: 'object', required: ['changes'], properties: { changes: { type: 'array' } } },
    },
  ],
  edges: [
    { id: 'e1', from: 'concept', to: 'review', when: { kind: 'status', is: 'done' } },
    { id: 'e2', from: 'review', to: 'art', when: { kind: 'gate', is: 'approved' } },
    { id: 'e3', from: 'review', to: 'concept', when: { kind: 'gate', is: 'modified' } },
    { id: 'e4', from: 'art', to: 'accept', when: { kind: 'artifact.accepted', is: true } },
    { id: 'e5', from: 'accept', to: 'integrate', when: { kind: 'status', is: 'done' } },
  ],
  notes: {
    nodeTypes: NODE_TYPES,
    edgeWhenKinds: EDGE_WHEN_KINDS,
    gateDecisions: GATE_DECISIONS,
    schemas: '只支持 type/properties/required/additionalProperties/items/enum/const/oneOf',
    humanGap: 'agent 节点声明 allowHuman:true 时，子 Agent 可用 needs_human 上抛缺口，插件创建交付请求并继续同一节点',
    publish: '不可由工具调用；由人经 /hnflow publish 或页面按钮完成',
  },
})

/**
 * Build the `hnflow_author` tool definition.
 * @param {{defineTool: Function, service: Record<string, any>, cwdOf: (agent: unknown) => string | null}} options - wiring.
 * @returns {Record<string, any>} tool definition.
 */
export function createAuthorTool(options) {
  const { defineTool, service, cwdOf } = options

  /**
   * Dispatch one action.
   * @param {Record<string, any>} args - validated arguments.
   * @param {{agent?: unknown}} exec - execution context.
   * @returns {Promise<string>} model-facing text.
   */
  const execute = async (args, exec) => {
    const cwd = cwdOf(exec?.agent)
    try {
      switch (args.action) {
        case 'schema':
          return JSON.stringify(FLOW_SCHEMA_REFERENCE, null, 2)
        case 'validate': {
          const definition = await resolveDefinition(service, args, cwd)
          if (definition.error !== undefined) return `error ${definition.error}`
          const problems = definitionProblems(definition.value)
          if (problems.length > 0) {
            return JSON.stringify({ ok: false, errors: problems.map((message) => ({ code: 'definition-invalid', message })) }, null, 2)
          }
          const result = await service.validate(definition.value)
          return JSON.stringify(result, null, 2)
        }
        case 'draft': {
          if (cwd === null) return 'error workspace-unavailable: this session has no workspace directory'
          const key = typeof args.flow === 'string' ? args.flow.trim() : ''
          if (key.length === 0) return 'error flow-required: draft needs the flow alias or id from list_flows'
          if (args.definition === null || typeof args.definition !== 'object') return 'error definition-required: pass the complete flow definition'
          const problems = definitionProblems(args.definition)
          if (problems.length > 0) return `error definition-invalid: ${problems.join('; ')}`
          const result = await service.draft({ cwd, key, definition: args.definition, note: typeof args.note === 'string' ? args.note : 'agent draft' })
          return JSON.stringify({ ok: true, ...result }, null, 2)
        }
        default:
          return 'error invalid-action: expected schema, validate or draft'
      }
    } catch (error) {
      return `error ${error?.code ?? 'internal'}: ${error?.message ?? String(error)}`
    }
  }

  return defineTool({
    name: 'hnflow_author',
    description:
      'Author HNFlow flows without publishing them. `schema` returns the definition format, `validate` runs the publish-time static checks on a definition (or on a referenced flow), `draft` writes the definition as a workspace override. There is no publish action: only a human can publish, through /hnflow publish or the page.',
    parameters: {
      action: { type: 'string', required: true, enum: ['schema', 'validate', 'draft'], description: 'Operation to perform.' },
      flow: { type: 'string', description: 'Referenced flow alias or id (validate without a definition, draft).' },
      definition: { type: 'object', additionalProperties: true, description: 'Complete flow definition for validate/draft.' },
      note: { type: 'string', description: 'Optional draft note.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute,
  })
}

/**
 * Resolve the definition argument, or read the referenced flow's definition.
 * @param {Record<string, any>} service - orchestrator.
 * @param {Record<string, any>} args - tool arguments.
 * @param {string | null} cwd - workspace root.
 * @returns {Promise<{value?: Record<string, any>, error?: string}>} definition or an error string.
 */
async function resolveDefinition(service, args, cwd) {
  if (args.definition !== null && typeof args.definition === 'object' && !Array.isArray(args.definition)) {
    return { value: args.definition }
  }
  const key = typeof args.flow === 'string' ? args.flow.trim() : ''
  if (key.length === 0) return { error: 'definition-required: pass a definition object or a referenced flow name' }
  if (cwd === null) return { error: 'workspace-unavailable: this session has no workspace directory' }
  const resolved = await service.describeFlow(cwd, key)
  return { value: resolved.definition }
}
