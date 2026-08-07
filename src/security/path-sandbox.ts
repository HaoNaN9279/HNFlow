// 路径沙箱（v0.9.4）：file/command 节点路径约束——与 fs-server resolveInside 等价语义，
// path 解析后必须位于 rootDir 内（含 rootDir 自身），../ 与绝对路径逃逸一律拒绝。
import { resolve, sep } from "node:path";

/** 路径逃逸沙箱：path 解析后不在 rootDir 内。 */
export class SandboxPathError extends Error {
  readonly name = "SandboxPathError";

  constructor(
    readonly rootDir: string,
    readonly path: string,
  ) {
    super(`路径逃逸沙箱：${path} 不在 ${rootDir} 内`);
  }
}

/** 安全路径解析：path 解析后必须位于 rootDir 内（含 rootDir 自身），否则返回 undefined；返回解析后绝对路径。 */
export function resolveSandboxPath(rootDir: string, path: string): string | undefined {
  const root = resolve(rootDir);
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    return undefined;
  }
  return target;
}
