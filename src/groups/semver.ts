// 语义版本工具（v0.3.0 T1）：严格 "x.y.z" 解析与比较。T2 版本递增依赖。
// 仅接受非负整数三段，不允许前缀/后缀/预发布段。
import { SemanticVersionError } from "./errors.js";

/** 语义版本号三段结构。 */
export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

/** 严格解析语义版本号；非法输入抛 SemanticVersionError。 */
export function parseSemVer(version: string): SemVer {
  const match = SEMVER_PATTERN.exec(version);
  if (match === null) {
    throw new SemanticVersionError(
      `非法语义版本号 "${version}"：必须为严格 "x.y.z" 格式（仅非负整数段，无前缀/后缀）`,
    );
  }
  // 正则已保证三段数字匹配，默认值仅为满足 noUncheckedIndexedAccess。
  const [, majorRaw = "0", minorRaw = "0", patchRaw = "0"] = match;
  return {
    major: Number(majorRaw),
    minor: Number(minorRaw),
    patch: Number(patchRaw),
  };
}

/** 比较两个已解析版本：a < b 返回 -1，相等 0，a > b 返回 1。 */
export function compareSemVer(a: SemVer, b: SemVer): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}
