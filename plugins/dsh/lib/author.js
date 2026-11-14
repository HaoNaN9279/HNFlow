/**
 * The `hnflow_author` tool: schema, validation and project flow files.
 *
 * A flow is capability-group content. Creating one writes to
 * `.hnflow/groups/<group>/flows/`; there is no separate library, revision or
 * publish step. Human-only actions are absent by construction.
 */

import { definitionProblems } from './assets.js'
import { EDGE_WHEN_KINDS, GATE_DECISIONS, NODE_TYPES } from './flow/definition.js'
import { defineTool } from './tool-schema.js'

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
      model: '可选：模型层 id',
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
    schemas: '只支持 type/properties/required/additionalProperties/items/enum/const/oneOf；顶层必须是 type:"object"；同一 schema 不能同时声明 type 与 oneOf（宿主 structured_output 校验器会拒绝）',
    humanGap: 'agent 节点声明 allowHuman:true 时，子 Agent 可用 needs_human 上抛缺口，插件创建交付请求并继续同一节点',
    policies: 'gate/request 可用 deadline.hours + onExpire(remind|fail)；verify 的 onInconclusive(gate|fail) 决定 judge 不确定时是否转人工门禁；request 的 onReject 支持 return|fallback|arbitrate|fail',
    mergeSet: 'merge 可用 set 声明常量（from 可为空）；data:assign 旧节点导入后就是这种 merge',
    scope: '流程属于能力组：create 写入项目本地组 .hnflow/groups/<group>/flows/ 并激活该组；group 省略时用 local',
    createIdentity: 'create 会生成或采用 flow.id；definition.flow.id 可省略，名称可由 create 的 name 参数提供',
    workflow: '流程可使用本组及依赖组的全部规则、技能、Agent、命令与工具；不存在的组内容不会被注入',
  },
})

/** Actions the authoring tool accepts. */
export const AUTHOR_ACTIONS = Object.freeze(['schema', 'validate', 'create', 'draft', 'delete', 'rename'])

/**
 * Build the `hnflow_author` tool definition.
 * @param {{service: Record<string, any>, cwdOf: (agent: unknown) => string | null}} options - wiring.
 * @returns {Record<string, any>} tool definition.
 */
export function createAuthorTool(options) {
  const { service, cwdOf } = options

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
        case 'schema': {
          // Extra kinds are host extensions, not part of the language: list
          // them from the live registry so `schema` never claims they exist
          // when the registering row is absent.
          const nodeTypes = typeof service.nodeKinds === 'function' ? service.nodeKinds() : [...NODE_TYPES]
          return JSON.stringify(
            {
              ...FLOW_SCHEMA_REFERENCE,
              notes: { ...FLOW_SCHEMA_REFERENCE.notes, nodeTypes },
            },
            null,
            2,
          )
        }
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
        case 'create': {
          if (cwd === null) return 'error workspace-unavailable: this session has no workspace directory'
          if (args.definition === null || typeof args.definition !== 'object') return 'error definition-required: pass the complete flow definition'
          const problems = definitionProblems(args.definition)
          if (problems.length > 0) return `error definition-invalid: ${problems.join('; ')}`
          const result = await service.createFlow({
            cwd,
            definition: args.definition,
            name: typeof args.name === 'string' ? args.name : undefined,
            folder: typeof args.folder === 'string' ? args.folder : '',
            note: typeof args.note === 'string' ? args.note : undefined,
          })
          return JSON.stringify({ ok: true, created: true, ...result }, null, 2)
        }
        case 'delete': {
          if (cwd === null) return 'error workspace-unavailable: this session has no workspace directory'
          const key = typeof args.flow === 'string' ? args.flow.trim() : ''
          if (key.length === 0) return 'error flow-required: delete needs the project-local flow id or name'
          const result = await service.deleteLocal({ cwd, key })
          return JSON.stringify({ ok: true, deleted: true, ...result }, null, 2)
        }
        case 'rename': {
          if (cwd === null) return 'error workspace-unavailable: this session has no workspace directory'
          const key = typeof args.flow === 'string' ? args.flow.trim() : ''
          const name = typeof args.name === 'string' ? args.name.trim() : ''
          if (key.length === 0) return 'error flow-required: rename needs the project-local flow id or name'
          if (name.length === 0) return 'error name-required: pass the new name'
          const result = await service.renameLocal({ cwd, key, name })
          return JSON.stringify({ ok: true, renamed: true, ...result }, null, 2)
        }
        default:
          return `error invalid-action: expected ${AUTHOR_ACTIONS.join(', ')}`
      }
    } catch (error) {
      return `error ${error?.code ?? 'internal'}: ${error?.message ?? String(error)}`
    }
  }

  return defineTool({
    name: 'hnflow_author',
    description:
      'Author HNFlow flows as capability-group content. `schema` returns the definition format, `validate` runs static checks, `create` writes a flow into a project-local capability group, `draft` updates a project-local flow file, and `delete`/`rename` manage project-local flows only. There is no publish, revision, or library step.',
    parameters: {
      action: { type: 'string', required: true, enum: [...AUTHOR_ACTIONS], description: 'Operation to perform.' },
      flow: { type: 'string', description: 'Flow qualified id, flow id or name (validate without a definition, draft, delete, rename).' },
      definition: { type: 'object', additionalProperties: true, description: 'Complete flow definition for validate/create/draft.' },
      name: { type: 'string', description: 'create/rename: display name.' },
      folder: { type: 'string', description: 'create: project-local capability group name (single path segment, default local).' },
      note: { type: 'string', description: 'Optional draft/creation note.' },
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
