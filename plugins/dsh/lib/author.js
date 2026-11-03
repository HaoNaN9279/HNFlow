/**
 * The `hnflow_author` tool: inspect, validate, and edit a workflow — inside the
 * workspace only.
 *
 * Guardrail: this tool has no action that writes an asset. Changing what every
 * workspace runs next is a user decision, and the only surface that can do it is
 * the `/workflow save asset` command, which the user types themselves.
 */

import { diffDocuments } from './json.js'

/** Actions the authoring tool accepts. */
export const AUTHOR_ACTIONS = ['schema', 'validate', 'save_override']

/**
 * Render the engine catalog as a compact reference.
 * @param {Record<string, any>} catalog - `workflow/describe` result.
 * @returns {string} model-facing text.
 */
export function formatSchema(catalog) {
  const nodes = Array.isArray(catalog.nodeTypes) ? catalog.nodeTypes : []
  const byCategory = new Map()
  for (const node of nodes) {
    const category = String(node.category ?? 'other')
    const list = byCategory.get(category) ?? []
    list.push(node.description ? `${node.type} — ${node.description}` : node.type)
    byCategory.set(category, list)
  }
  const sections = [...byCategory.entries()].map(([category, entries]) => `${category}:\n  ${entries.join('\n  ')}`)
  const ports = Array.isArray(catalog.portTypes) ? catalog.portTypes.join(', ') : ''
  return [`node types (${nodes.length}):`, ...sections, '', `port types: ${ports}`].join('\n')
}

/**
 * Render a validation result.
 * @param {{valid: boolean, errors: string[]}} result - validation result.
 * @returns {string} model-facing text.
 */
export function formatValidation(result) {
  if (result.valid) return 'definition is valid'
  const errors = Array.isArray(result.errors) ? result.errors : []
  return [`definition is invalid (${errors.length} problem(s)):`, ...errors.map((error) => `- ${error}`)].join('\n')
}

/**
 * Render the difference between two definitions.
 * @param {Record<string, any>} before - current definition.
 * @param {Record<string, any>} after - proposed definition.
 * @returns {string} summary lines.
 */
export function formatDefinitionDiff(before, after) {
  const changes = diffDocuments(before, after, { maxEntries: 20 })
  if (changes.length === 0) return 'no structural difference'
  return changes.map((change) => `- ${change.path}: ${JSON.stringify(change.from)} → ${JSON.stringify(change.to)}`).join('\n')
}

/**
 * Build the `hnflow_author` tool definition.
 * @param {{
 *   defineTool: Function,
 *   service: import('./service.js').HnflowService,
 *   cwdOf: (agent: unknown) => string | null,
 * }} options - wiring.
 * @returns {Record<string, any>} the tool definition.
 */
export function createWorkflowAuthorTool(options) {
  const { defineTool, service, cwdOf } = options

  /**
   * Run one action.
   * @param {Record<string, any>} args - validated arguments.
   * @param {{agent?: unknown}} exec - execution context.
   * @returns {Promise<string>} model-facing text.
   */
  const execute = async (args, exec) => {
    const cwd = cwdOf(exec?.agent)
    try {
      if (args.action === 'schema') return formatSchema(await service.schema())
      if (cwd === null) return 'error workspace-unavailable: this session has no workspace directory'
      return await run(args, cwd)
    } catch (error) {
      return `error ${error?.code ?? 'internal'}: ${error?.message ?? String(error)}`
    }
  }

  /**
   * Dispatch one workspace action.
   * @param {Record<string, any>} args - validated arguments.
   * @param {string} cwd - workspace root.
   * @returns {Promise<string>} model-facing text.
   */
  const run = async (args, cwd) => {
    switch (args.action) {
      case 'validate':
        return formatValidation(await service.validateDefinition(requireDefinition(args)))
      case 'save_override': {
        const key = requireWorkflow(args)
        const definition = requireDefinition(args)
        const validation = await service.validateDefinition(definition)
        if (!validation.valid) return `nothing written\n${formatValidation(validation)}`
        const before = (await service.resolve(cwd, key)).definition
        const stored = await service.writeOverride({
          cwd,
          key,
          definition,
          note: String(args.note ?? '').slice(0, 500),
          origin: 'agent',
        })
        return [
          `saved the workspace override for ${key} (asset ${stored.assetId}, base r${stored.baseRevision})`,
          'the asset is unchanged; `/workflow override diff` shows this diff, `/workflow override reset` drops it',
          formatDefinitionDiff(before, definition),
        ].join('\n')
      }
      default:
        return `error invalid-action: expected one of ${AUTHOR_ACTIONS.join(', ')}`
    }
  }

  return defineTool({
    name: 'hnflow_author',
    description:
      'Inspect, validate, and edit HNFlow workflow definitions inside this workspace. `schema` lists node and port types, `validate` checks a definition, and `save_override` stores the definition as the workspace override. There is deliberately no action that writes the shared asset: only the user can run `/workflow save asset`.',
    parameters: {
      action: { type: 'string', required: true, enum: AUTHOR_ACTIONS, description: 'Operation to perform.' },
      workflow: { type: 'string', description: 'Workflow alias or asset id; required by save_override.' },
      definition: { type: 'object', additionalProperties: true, description: 'Complete definition object; required by validate and save_override.' },
      note: { type: 'string', description: 'Why this workspace overrides the asset; recorded in the change log.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute,
  })
}

/**
 * Require the definition argument.
 * @param {Record<string, any>} args - tool arguments.
 * @returns {Record<string, any>} the definition.
 */
function requireDefinition(args) {
  const definition = args.definition
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
    const error = new Error('definition is required: pass the complete workflow definition object')
    error.code = 'definition-required'
    throw error
  }
  return definition
}

/**
 * Require the workflow argument.
 * @param {Record<string, any>} args - tool arguments.
 * @returns {string} the workflow key.
 */
function requireWorkflow(args) {
  const key = typeof args.workflow === 'string' ? args.workflow.trim() : ''
  if (key.length === 0) {
    const error = new Error('workflow is required: pass the alias or asset id')
    error.code = 'workflow-required'
    throw error
  }
  return key
}
