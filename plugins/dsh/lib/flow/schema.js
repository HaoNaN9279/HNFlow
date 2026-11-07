/**
 * The raw JSON Schema subset this plugin accepts.
 *
 * `structured_output`, the subagent seam and `@deepseek-ai/dsh-tools` all share
 * one protocol-level schema subset: `type`, `properties`, `required`,
 * `additionalProperties`, `items`, `enum`, `const` and `oneOf`. A definition
 * that leaves that subset would be rejected by the host at spawn time, so the
 * publisher rejects it first, with a node-scoped error instead of a runtime
 * surprise.
 *
 * These helpers are pure and dependency-free: the publisher, the page and the
 * tests all use the same implementation, and no harness package is imported to
 * validate a user's JSON.
 */

/** Schema keywords this plugin accepts. */
export const SUPPORTED_KEYWORDS = Object.freeze(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'oneOf'])
/** JSON types a schema may name. */
export const JSON_TYPES = Object.freeze(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

/** A schema-shape failure with a stable code. */
export class SchemaError extends Error {
  /**
   * @param {string} code - `schema-unsupported` / `schema-invalid`.
   * @param {string} message - human-readable explanation.
   * @param {string} [path] - JSON pointer-ish location inside the schema.
   */
  constructor(code, message, path = '') {
    super(message)
    this.name = 'SchemaError'
    this.code = code
    this.path = path
  }
}

/**
 * Assert that a value is an object-shaped schema in the supported subset.
 * @param {unknown} schema - candidate schema.
 * @param {string} [path] - location used in the error.
 * @returns {Record<string, any>} the schema, unchanged.
 * @throws {SchemaError} when a keyword or shape is unsupported.
 */
export function assertObjectJsonSchema(schema, path = 'schema') {
  assertSchema(schema, path)
  if (schema?.type !== undefined && schema.type !== 'object') {
    throw new SchemaError('schema-unsupported', `${path}: the top-level schema must be type "object"`, path)
  }
  if (schema?.type === undefined) {
    throw new SchemaError('schema-unsupported', `${path}: the top-level schema needs type "object"`, path)
  }
  return schema
}

/**
 * Assert one schema node (recursively).
 * @param {unknown} schema - candidate.
 * @param {string} path - location.
 * @returns {void}
 * @throws {SchemaError} on an unsupported keyword or shape.
 */
export function assertSchema(schema, path) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new SchemaError('schema-invalid', `${path}: a schema must be an object`, path)
  }
  const source = /** @type {Record<string, any>} */ (schema)
  for (const key of Object.keys(source)) {
    if (!SUPPORTED_KEYWORDS.includes(key)) {
      throw new SchemaError('schema-unsupported', `${path}: keyword "${key}" is outside the supported subset (${SUPPORTED_KEYWORDS.join(', ')})`, `${path}.${key}`)
    }
  }
  if (source.type !== undefined && !JSON_TYPES.includes(source.type)) {
    throw new SchemaError('schema-invalid', `${path}.type: unknown type ${JSON.stringify(source.type)}`, `${path}.type`)
  }
  // The host's structured-output validator rejects a schema that declares both
  // `type` and `oneOf`; catching it at publish time beats a runtime surprise.
  if (source.type !== undefined && source.oneOf !== undefined) {
    throw new SchemaError('schema-unsupported', `${path}: a schema cannot declare both type and oneOf`, `${path}.oneOf`)
  }
  if (source.type === 'object') {
    if (source.properties !== undefined) {
      if (source.properties === null || typeof source.properties !== 'object' || Array.isArray(source.properties)) {
        throw new SchemaError('schema-invalid', `${path}.properties must be an object`, `${path}.properties`)
      }
      for (const [name, child] of Object.entries(source.properties)) assertSchema(child, `${path}.properties.${name}`)
    }
    if (source.required !== undefined) {
      if (!Array.isArray(source.required) || source.required.some((name) => typeof name !== 'string')) {
        throw new SchemaError('schema-invalid', `${path}.required must be an array of strings`, `${path}.required`)
      }
    }
    if (source.additionalProperties !== undefined && typeof source.additionalProperties !== 'boolean') {
      throw new SchemaError('schema-unsupported', `${path}.additionalProperties: only a boolean is supported`, `${path}.additionalProperties`)
    }
  }
  if (source.type === 'array') {
    if (source.items !== undefined) assertSchema(source.items, `${path}.items`)
  }
  if (source.enum !== undefined && !Array.isArray(source.enum)) {
    throw new SchemaError('schema-invalid', `${path}.enum must be an array`, `${path}.enum`)
  }
  if (source.oneOf !== undefined) {
    if (!Array.isArray(source.oneOf) || source.oneOf.length === 0) {
      throw new SchemaError('schema-invalid', `${path}.oneOf must be a non-empty array`, `${path}.oneOf`)
    }
    source.oneOf.forEach((child, index) => assertSchema(child, `${path}.oneOf[${index}]`))
  }
}

/**
 * Validate a JSON value against the supported schema subset.
 * @param {unknown} value - value to check.
 * @param {unknown} schema - schema to check it against.
 * @param {string} [path] - location used in violations.
 * @returns {{ok: boolean, violations: {path: string, expected: string, actual: string}[]}} result.
 */
export function validateValue(value, schema, path = '') {
  /** @type {{path: string, expected: string, actual: string}[]} */
  const violations = []
  checkValue(value, schema, path, violations)
  return { ok: violations.length === 0, violations }
}

/**
 * Recursive worker for {@link validateValue}.
 * @param {unknown} value - value.
 * @param {any} schema - schema.
 * @param {string} path - location.
 * @param {{path: string, expected: string, actual: string}[]} violations - collector.
 * @returns {void}
 */
function checkValue(value, schema, path, violations) {
  if (schema === null || typeof schema !== 'object') return
  const at = path.length === 0 ? 'value' : path
  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    violations.push({ path: at, expected: `const ${JSON.stringify(schema.const)}`, actual: typeOf(value) })
    return
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => deepEqual(entry, value))) {
    violations.push({ path: at, expected: `one of ${JSON.stringify(schema.enum)}`, actual: JSON.stringify(value) })
    return
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((branch) => validateValue(value, branch, path).ok)
    if (matches.length !== 1) {
      violations.push({ path: at, expected: 'exactly one oneOf branch', actual: matches.length === 0 ? 'none matched' : `${matches.length} matched` })
      return
    }
  }
  if (schema.type === undefined) return
  const actual = typeOf(value)
  if (schema.type === 'integer') {
    if (!Number.isInteger(value)) violations.push({ path: at, expected: 'integer', actual })
    return
  }
  if (actual !== schema.type) {
    violations.push({ path: at, expected: schema.type, actual })
    return
  }
  if (schema.type === 'object') {
    const object = /** @type {Record<string, any>} */ (value)
    const properties = schema.properties !== null && typeof schema.properties === 'object' ? schema.properties : {}
    for (const name of Array.isArray(schema.required) ? schema.required : []) {
      if (!(name in object)) violations.push({ path: `${at}.${name}`, expected: 'present', actual: 'missing' })
    }
    for (const [name, child] of Object.entries(properties)) {
      if (name in object) checkValue(object[name], child, `${at}.${name}`, violations)
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(object)) {
        if (!(name in properties)) violations.push({ path: `${at}.${name}`, expected: 'declared property', actual: 'unexpected property' })
      }
    }
    return
  }
  if (schema.type === 'array' && schema.items !== undefined) {
    /** @type {unknown[]} */
    const array = /** @type {unknown[]} */ (value)
    array.forEach((item, index) => checkValue(item, schema.items, `${at}[${index}]`, violations))
  }
}

/**
 * Conservative assignability: can every value of `upstream` be consumed by
 * `downstream`? Used for edge contracts at publish time.
 * @param {unknown} upstream - producer schema.
 * @param {unknown} downstream - consumer schema.
 * @param {string} [path] - location.
 * @returns {{ok: boolean, violations: {path: string, expected: string, actual: string}[]}} result.
 */
export function isAssignable(upstream, downstream, path = '') {
  /** @type {{path: string, expected: string, actual: string}[]} */
  const violations = []
  checkAssignable(upstream, downstream, path, violations)
  return { ok: violations.length === 0, violations }
}

/**
 * Recursive worker for {@link isAssignable}.
 * @param {any} upstream - producer schema.
 * @param {any} downstream - consumer schema.
 * @param {string} path - location.
 * @param {{path: string, expected: string, actual: string}[]} violations - collector.
 * @returns {void}
 */
function checkAssignable(upstream, downstream, path, violations) {
  if (upstream === null || typeof upstream !== 'object' || downstream === null || typeof downstream !== 'object') return
  const at = path.length === 0 ? 'contract' : path
  if (downstream.type !== undefined && upstream.type !== undefined && upstream.type !== downstream.type) {
    violations.push({ path: at, expected: downstream.type, actual: upstream.type })
    return
  }
  if (downstream.const !== undefined && upstream.const !== downstream.const) {
    violations.push({ path: at, expected: `const ${JSON.stringify(downstream.const)}`, actual: JSON.stringify(upstream.const ?? null) })
  }
  if (Array.isArray(downstream.enum) && Array.isArray(upstream.enum)) {
    const missing = upstream.enum.filter((entry) => !downstream.enum.some((allowed) => deepEqual(allowed, entry)))
    if (missing.length > 0) violations.push({ path: at, expected: `subset of ${JSON.stringify(downstream.enum)}`, actual: JSON.stringify(missing) })
  }
  if (downstream.type === 'object' || (downstream.type === undefined && downstream.properties !== undefined)) {
    const downstreamProperties = downstream.properties !== null && typeof downstream.properties === 'object' ? downstream.properties : {}
    const upstreamProperties = upstream.properties !== null && typeof upstream.properties === 'object' ? upstream.properties : {}
    const upstreamOpen = upstream.type === 'object' && upstream.additionalProperties !== false
    for (const name of Array.isArray(downstream.required) ? downstream.required : []) {
      if (!(name in upstreamProperties) && !upstreamOpen) {
        violations.push({ path: `${at}.${name}`, expected: 'produced by upstream', actual: 'absent from upstream schema' })
        continue
      }
      if (name in upstreamProperties) checkAssignable(upstreamProperties[name], downstreamProperties[name], `${at}.${name}`, violations)
    }
    for (const [name, child] of Object.entries(downstreamProperties)) {
      if (!(name in upstreamProperties)) continue
      checkAssignable(upstreamProperties[name], child, `${at}.${name}`, violations)
    }
  }
  if (downstream.type === 'array' && downstream.items !== undefined && upstream.items !== undefined) {
    checkAssignable(upstream.items, downstream.items, `${at}[]`, violations)
  }
}

/**
 * The JSON type name of a value.
 * @param {unknown} value - any JSON value.
 * @returns {string} type name.
 */
export function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  return typeof value
}

/**
 * Structural equality for JSON values.
 * @param {unknown} left - value.
 * @param {unknown} right - value.
 * @returns {boolean} true when equal.
 */
export function deepEqual(left, right) {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((item, index) => deepEqual(item, right[index]))
  }
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left).sort()
    const rightKeys = Object.keys(right).sort()
    if (leftKeys.length !== rightKeys.length) return false
    return leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]))
  }
  return false
}
