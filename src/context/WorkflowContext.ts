import type { VariablePath } from "../model/types.js"

/**
 * 三级作用域上下文：`global` / `workflow` / `node:<nodeId>`（节点级，按 nodeId 完全隔离）。
 *
 * 内部存储使用无原型对象：避免 `__proto__`、`toString` 等 key 沿原型链
 * 返回非 undefined 值，破坏「未设置变量返回 undefined」的语义。
 */

/** 未知作用域错误。scope 必须为 `global` / `workflow` / `node:<nodeId>`。 */
export class UnknownScopeError extends Error {
  readonly name = "UnknownScopeError"
  constructor(readonly scope: string) {
    super(`unknown scope: "${scope}"`)
  }
}

/** 变量路径格式错误。路径必须为 `scope:key`（含 node 前缀形式 `node:<nodeId>:key`）。 */
export class InvalidPathError extends Error {
  readonly name = "InvalidPathError"
  constructor(readonly path: string) {
    super(`invalid variable path: "${path}" (expected "scope:key")`)
  }
}

/** 变量 key 为空。 */
export class InvalidKeyError extends Error {
  readonly name = "InvalidKeyError"
  constructor() {
    super("variable key must not be empty")
  }
}

function createStore<V>(): Record<string, V> {
  // 无原型对象：不继承 Object.prototype，key 访问不命中原型链
  return Object.create(null) as Record<string, V>
}

function copyStore(store: Record<string, unknown>): Record<string, unknown> {
  const copy = createStore<unknown>()
  for (const key of Object.keys(store)) {
    copy[key] = store[key]
  }
  return copy
}

type ResolvedScope =
  | { readonly kind: "flat"; readonly name: "global" | "workflow" }
  | { readonly kind: "node"; readonly nodeId: string }

function assertNever(value: never): never {
  throw new Error(`unreachable value: ${JSON.stringify(value)}`)
}

export class WorkflowContext {
  private readonly global: Record<string, unknown>
  private readonly workflow: Record<string, unknown>
  private readonly node: Record<string, Record<string, unknown>>

  constructor(init?: {
    readonly globalVariables?: Record<string, unknown>
    readonly workflowVariables?: Record<string, unknown>
  }) {
    this.global =
      init?.globalVariables === undefined
        ? createStore<unknown>()
        : copyStore(init.globalVariables)
    this.workflow =
      init?.workflowVariables === undefined
        ? createStore<unknown>()
        : copyStore(init.workflowVariables)
    this.node = createStore<Record<string, unknown>>()
  }

  get(scope: string, key: string): unknown {
    this.assertKey(key)
    const resolved = this.resolveScope(scope)
    switch (resolved.kind) {
      case "flat":
        return resolved.name === "global" ? this.global[key] : this.workflow[key]
      case "node": {
        const store = this.node[resolved.nodeId]
        return store === undefined ? undefined : store[key]
      }
      default:
        return assertNever(resolved)
    }
  }

  set(scope: string, key: string, value: unknown): void {
    this.assertKey(key)
    const resolved = this.resolveScope(scope)
    switch (resolved.kind) {
      case "flat":
        if (resolved.name === "global") {
          this.global[key] = value
        } else {
          this.workflow[key] = value
        }
        return
      case "node":
        this.nodeStore(resolved.nodeId)[key] = value
        return
      default:
        assertNever(resolved)
    }
  }

  getByPath(path: VariablePath): unknown {
    const { scope, key } = this.splitPath(path)
    return this.get(scope, key)
  }

  setByPath(path: VariablePath, value: unknown): void {
    const { scope, key } = this.splitPath(path)
    this.set(scope, key, value)
  }

  getAll(scope: string): Record<string, unknown> {
    const resolved = this.resolveScope(scope)
    switch (resolved.kind) {
      case "flat":
        return resolved.name === "global"
          ? copyStore(this.global)
          : copyStore(this.workflow)
      case "node": {
        const store = this.node[resolved.nodeId]
        return store === undefined ? createStore<unknown>() : copyStore(store)
      }
      default:
        return assertNever(resolved)
    }
  }

  remove(scope: string, key: string): void {
    this.assertKey(key)
    const resolved = this.resolveScope(scope)
    switch (resolved.kind) {
      case "flat":
        if (resolved.name === "global") {
          delete this.global[key]
        } else {
          delete this.workflow[key]
        }
        return
      case "node": {
        const store = this.node[resolved.nodeId]
        if (store !== undefined) {
          delete store[key]
        }
        return
      }
      default:
        assertNever(resolved)
    }
  }

  getSnapshot(): {
    readonly global: Record<string, unknown>
    readonly workflow: Record<string, unknown>
    readonly node: Record<string, Record<string, unknown>>
  } {
    const node: Record<string, Record<string, unknown>> =
      createStore<Record<string, unknown>>()
    for (const nodeId of Object.keys(this.node)) {
      const store = this.node[nodeId]
      if (store !== undefined) {
        // 快照 key 使用完整作用域标识（与 get/set 的 scope 参数一致）
        node[`node:${nodeId}`] = copyStore(store)
      }
    }
    return {
      global: copyStore(this.global),
      workflow: copyStore(this.workflow),
      node,
    }
  }

  private assertKey(key: string): void {
    if (key === "") {
      throw new InvalidKeyError()
    }
  }

  private nodeStore(nodeId: string): Record<string, unknown> {
    const existing = this.node[nodeId]
    if (existing !== undefined) {
      return existing
    }
    const created = createStore<unknown>()
    this.node[nodeId] = created
    return created
  }

  private resolveScope(scope: string): ResolvedScope {
    if (scope === "global" || scope === "workflow") {
      return { kind: "flat", name: scope }
    }
    if (scope.startsWith("node:")) {
      const nodeId = scope.slice("node:".length)
      if (nodeId === "") {
        // "node:" 空节点 id 非法
        throw new UnknownScopeError(scope)
      }
      return { kind: "node", nodeId }
    }
    throw new UnknownScopeError(scope)
  }

  /**
   * 切分 `scope:key`，规则：
   * - `node:` 前缀路径按第二个冒号切分：`"node:foo:count"` → scope=`"node:foo"`, key=`"count"`
   * - 其余路径按第一个冒号切分，多余冒号归入 key：`"a:b:c"` → scope=`"a"`, key=`"b:c"`
   * - 无冒号抛 InvalidPathError
   */
  private splitPath(path: VariablePath): { readonly scope: string; readonly key: string } {
    if (path.startsWith("node:")) {
      const rest = path.slice("node:".length)
      const secondColon = rest.indexOf(":")
      if (secondColon === -1) {
        return { scope: `node:${rest}`, key: "" }
      }
      const nodeId = rest.slice(0, secondColon)
      const key = rest.slice(secondColon + 1)
      return { scope: `node:${nodeId}`, key }
    }
    const separator = path.indexOf(":")
    if (separator === -1) {
      throw new InvalidPathError(path)
    }
    return {
      scope: path.slice(0, separator),
      key: path.slice(separator + 1),
    }
  }
}
