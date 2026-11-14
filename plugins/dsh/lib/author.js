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
    schemas: '只支持 type/properties/required/additionalProperties/items/enum/const/oneOf；顶层必须是 type:"object"；同一 schema 不能同时声明 type 与 oneOf（宿主 structured_output 校验器会拒绝）',
    humanGap: 'agent 节点声明 allowHuman:true 时，子 Agent 可用 needs_human 上抛缺口，插件创建交付请求并继续同一节点',
    policies: 'gate/request 可用 deadline.hours + onExpire(remind|fail)；verify 的 onInconclusive(gate|fail) 决定 judge 不确定时是否转人工门禁；request 的 onReject 支持 return|fallback|arbitrate|fail',
    mergeSet: 'merge 可用 set 声明常量（from 可为空）；data:assign 旧节点导入后就是这种 merge',
    scope: 'create 的 scope: project（默认，项目内草稿，只在本工作区可见/可运行）或 library（新资产 r1，并默认引用到本工作区）',
    createIdentity: 'create 会生成 flow.id；definition.flow.id 可省略，名称可由 create 的 name 参数提供',
    promote: 'promote 把项目草稿提升为库资产 r1 并替换为引用；之后修改它仍需人工发布',
    publish: '不可由工具调用；由人经 /hnflow publish 或页面按钮完成',
  },
})

/** Actions the authoring tool accepts. */
export const AUTHOR_ACTIONS = Object.freeze(['schema', 'validate', 'create', 'draft', 'promote', 'delete', 'rename'])

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
            scope: args.scope === 'library' ? 'library' : 'project',
            name: typeof args.name === 'string' ? args.name : undefined,
            folder: typeof args.folder === 'string' ? args.folder : '',
            note: typeof args.note === 'string' ? args.note : undefined,
            alias: typeof args.alias === 'string' ? args.alias : '',
            reference: args.reference !== false,
          })
          return JSON.stringify({ ok: true, created: true, ...result }, null, 2)
        }
        case 'promote': {
          if (cwd === null) return 'error workspace-unavailable: this session has no workspace directory'
          const key = typeof args.flow === 'string' ? args.flow.trim() : ''
          if (key.length === 0) return 'error flow-required: promote needs the project-local flow id or name'
          const result = await service.promote({
            cwd,
            key,
            name: typeof args.name === 'string' ? args.name : undefined,
            folder: typeof args.folder === 'string' ? args.folder : undefined,
            alias: typeof args.alias === 'string' ? args.alias : '',
          })
          return JSON.stringify({ ok: true, promoted: true, ...result }, null, 2)
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
      'Author and manage HNFlow flows without publishing. `schema` returns the definition format, `validate` runs publish-time static checks, `create` creates a project-local draft (default) or a library asset r1, `draft` writes an agent draft, `promote` turns a project draft into a library asset, and `delete`/`rename` manage project-local drafts only. There is no publish action: changing an existing library asset still requires a human to publish it through /hnflow publish or the page.',
    parameters: {
      action: { type: 'string', required: true, enum: [...AUTHOR_ACTIONS], description: 'Operation to perform.' },
      flow: { type: 'string', description: 'Referenced/local flow alias, name or id (validate without a definition, draft, promote, delete, rename).' },
      definition: { type: 'object', additionalProperties: true, description: 'Complete flow definition for validate/create/draft.' },
      scope: { type: 'string', enum: ['project', 'library'], description: 'create only: project-local draft (default) or reusable library asset r1.' },
      name: { type: 'string', description: 'create/promote/rename: display name.' },
      folder: { type: 'string', description: 'create/promote: library- or project-relative folder (multi-level with /).' },
      alias: { type: 'string', description: 'create/promote with scope library: reference alias in this workspace.' },
      reference: { type: 'boolean', description: 'create scope=library: also reference it here (default true).' },
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
