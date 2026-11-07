/**
 * A local `defineTool` for harness tools.
 *
 * The harness `@deepseek-ai/dsh-tools` package is not resolvable from a linked
 * plugin: its bare import escapes the profile's node_modules and the Loader's
 * internal importer is not exposed to plugin rows. Instead of failing the tool
 * surface, this module compiles the small authoring DSL we use (`string`,
 * `number`, `boolean`, `object` plus `enum`/`required`/`additionalProperties`)
 * to the raw JSON Schema the registry expects, and validates arguments before
 * calling `execute` — the same contract `defineTool` provides.
 */

import { validateValue } from './flow/schema.js'

/** Schema types this compiler accepts. */
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array'])

/**
 * Compile one authoring node to raw JSON Schema.
 * @param {Record<string, any>} spec - authoring node.
 * @param {string} path - location for diagnostics.
 * @returns {Record<string, any>} raw JSON Schema.
 */
export function toJsonSchema(spec, path = 'schema') {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error(`${path}: a schema node must be an object`)
  }
  if (!TYPES.has(spec.type)) throw new Error(`${path}: unsupported type ${JSON.stringify(spec.type)}`)
  /** @type {Record<string, any>} */
  const schema = { type: spec.type }
  if (typeof spec.description === 'string' && spec.description.length > 0) schema.description = spec.description
  if (Array.isArray(spec.enum)) schema.enum = [...spec.enum]
  if (spec.type === 'object') {
    if (spec.properties !== undefined) {
      /** @type {Record<string, any>} */
      const properties = {}
      /** @type {string[]} */
      const required = []
      for (const [name, child] of Object.entries(spec.properties)) {
        properties[name] = toJsonSchema(child, `${path}.properties.${name}`)
        if (child?.required === true) required.push(name)
      }
      schema.properties = properties
      if (required.length > 0) schema.required = required
    }
    schema.additionalProperties = spec.additionalProperties === true
  }
  if (spec.type === 'array') {
    if (spec.items !== undefined) schema.items = toJsonSchema(spec.items, `${path}.items`)
    else schema.items = {}
  }
  return schema
}

/**
 * Build the parameter schema of a tool from the per-property DSL.
 * @param {Record<string, any>} parameters - property spec map.
 * @returns {{schema: Record<string, any>, required: string[]}} parameters.
 */
export function compileParameters(parameters) {
  const schema = toJsonSchema({ type: 'object', properties: parameters ?? {}, additionalProperties: true }, 'parameters')
  return { schema, required: Array.isArray(schema.required) ? schema.required : [] }
}

/**
 * Compile and validate a tool definition.
 * @param {{
 *   name: string,
 *   description: string,
 *   parameters: Record<string, any>,
 *   output: {schema: Record<string, any>, render: (args: any, value: any) => unknown[]},
 *   execute: (args: Record<string, any>, exec: Record<string, any>) => Promise<any> | any,
 * }} options - definition.
 * @returns {Record<string, any>} registry-ready definition.
 */
export function defineTool(options) {
  const parameters = toJsonSchema({ type: 'object', properties: options.parameters ?? {}, additionalProperties: true }, 'parameters')
  const outputSchema = toJsonSchema(options.output.schema, 'output.schema')
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: { schema: outputSchema, render: options.output.render },
    async execute(args, exec) {
      const checked = validateValue(args ?? {}, parameters, 'arguments')
      if (!checked.ok) {
        const first = checked.violations[0]
        throw Object.assign(new Error(`invalid arguments: ${first.path} expects ${first.expected}, got ${first.actual}`), {
          code: 'INVALID_ARGS',
          violations: checked.violations,
        })
      }
      return options.execute(args ?? {}, exec)
    },
  }
}
