// 功能组模块错误类集中定义（v0.3.0 T1）：加载 / 扫描 / 语义版本三类错误。
// 惯例同 src/execution/errors.ts：错误类集中于单文件，调用方按 name 或 instanceof 区分。

/** 语义版本号非法：parseSemVer 对非严格 "x.y.z" 输入抛出。 */
export class SemanticVersionError extends Error {
  readonly name = "SemanticVersionError";
  constructor(message: string) { super(message); }
}

/** group.json 读取 / 解析 / 校验失败：loadGroup 对文件缺失、非法 JSON、字段不合法抛出。 */
export class GroupFileError extends Error {
  readonly name = "GroupFileError";
  constructor(message: string) { super(message); }
}

/** 功能组目录扫描失败：scanGroups 对根目录缺失 / 不可访问抛出（单个 group.json 损坏只警告不中断）。 */
export class GroupScanError extends Error {
  readonly name = "GroupScanError";
  constructor(message: string) { super(message); }
}

/** 功能组依赖解析失败：resolveWorkflowGroups 对声明形状非法 / 版本不存在 / 依赖范围不匹配 / 循环依赖抛出（消息含节点路径或完整循环路径）。 */
export class GroupResolveError extends Error {
  readonly name = "GroupResolveError";
  constructor(message: string) { super(message); }
}
