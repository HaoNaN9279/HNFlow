// 功能组内容加载器（v0.3.1 T1）：给定功能组根目录 + CapabilityGroup + 版本号，读取版本目录内容文件。
// 解析为结构化 LoadedGroupContent；文件缺失 / JSON 非法 / 字段缺失抛 GroupContentLoadError（错误含路径与原因）。
// 目录结构：rootDir/<namespace 路径>/v<version>/ 下为内容文件（agent.md / tools/*.json / rules/*.md / mcp.json）。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadVersion } from "./load.js";
import type { CapabilityGroup, RuleEntry } from "./types.js";

/** 工具文件内容：tools/*.json 声明式描述。 */
export interface LoadedTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>; // JSON schema（zod 转换由消费方做）
  readonly path: string; // 相对版本目录路径，如 "tools/read_file.json"
}

/** 规则文件内容 + frontmatter constraint。 */
export interface LoadedRule {
  readonly path: string;
  readonly order: number;
  readonly text: string;
  readonly constraint?: string; // YAML frontmatter 的 constraint 字段（如 "json"/"markdown"），无则 undefined
}

/** MCP 配置内容：mcp.json 解析。 */
export interface LoadedMcp {
  readonly name: string;
  readonly config: Record<string, unknown>; // mcp.json 除 name 外的字段（原样透传）
  readonly path: string;
}

/** 单个功能组版本加载后的完整内容。 */
export interface LoadedGroupContent {
  readonly guid: string;
  readonly namespace: string;
  readonly version: string;
  readonly agent?: { readonly text: string }; // agent.md 文本；无 agent 文件则 undefined
  readonly tools: readonly LoadedTool[];
  readonly rules: readonly LoadedRule[];
  readonly mcps: readonly LoadedMcp[];
}

/** 功能组内容加载失败：文件缺失 / JSON 非法 / 字段缺失。 */
export class GroupContentLoadError extends Error {
  readonly name = "GroupContentLoadError";
  readonly path: string; // 出问题的文件路径
  readonly reason: string;
  constructor(path: string, reason: string) {
    super(`功能组内容加载失败：${path}（${reason}）`);
    this.path = path;
    this.reason = reason;
  }
}

// ---- 文件读取辅助 ----

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getErrnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** 读取文本文件：缺失 / 读取失败抛 GroupContentLoadError（含路径与原因）。 */
async function readTextFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (getErrnoCode(error) === "ENOENT") {
      throw new GroupContentLoadError(path, "文件不存在");
    }
    throw new GroupContentLoadError(path, describeError(error));
  }
}

/** 读取可选文本文件：ENOENT 返回 undefined（agent 缺失容忍），其他错误抛 GroupContentLoadError。 */
async function readOptionalTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (getErrnoCode(error) === "ENOENT") {
      return undefined;
    }
    throw new GroupContentLoadError(path, describeError(error));
  }
}

/** 读取 JSON 文件：文件缺失 / JSON 非法抛 GroupContentLoadError（含路径与原因）。 */
async function readJsonFile(path: string): Promise<unknown> {
  const raw = await readTextFile(path);
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new GroupContentLoadError(path, `JSON 解析失败：${describeError(error)}`);
  }
}

/** 运行时判断：非空非数组对象（JSON 对象根节点 / parameters / config）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---- 资源解析 ----

/** 解析工具文件：tools/*.json 声明式描述。字段缺失 / 类型不合法抛 GroupContentLoadError（含路径）。 */
async function loadTool(versionDir: string, relPath: string): Promise<LoadedTool> {
  const filePath = join(versionDir, relPath);
  const parsed = await readJsonFile(filePath);
  if (!isRecord(parsed)) {
    throw new GroupContentLoadError(filePath, "工具文件根节点必须是 JSON 对象");
  }
  if (typeof parsed.name !== "string") {
    throw new GroupContentLoadError(filePath, "工具字段 name 必须为字符串");
  }
  if (typeof parsed.description !== "string") {
    throw new GroupContentLoadError(filePath, "工具字段 description 必须为字符串");
  }
  if (!isRecord(parsed.parameters)) {
    throw new GroupContentLoadError(filePath, "工具字段 parameters 必须为 JSON 对象");
  }
  return { name: parsed.name, description: parsed.description, parameters: parsed.parameters, path: relPath };
}

/**
 * 解析规则 frontmatter：文件开头 `---\n...\n---` 包裹的 YAML 片段，提取 constraint 字段（行首匹配前缀）。
 * 无 frontmatter / 无数 constraint → 返回空对象。不引入 yaml 依赖，简单行解析即可。
 */
function parseRuleFrontmatter(text: string): { constraint?: string } {
  if (!text.startsWith("---\n")) {
    return {};
  }
  const closing = text.indexOf("\n---", 4);
  if (closing === -1) {
    return {};
  }
  const frontmatter = text.slice(4, closing);
  for (const line of frontmatter.split("\n")) {
    if (line.startsWith("constraint:")) {
      const value = line.slice("constraint:".length).trim();
      return value === "" ? {} : { constraint: value };
    }
  }
  return {};
}

/** 解析规则文件：读取文本 + frontmatter constraint（无则省略）。 */
async function loadRule(versionDir: string, entry: RuleEntry): Promise<LoadedRule> {
  const filePath = join(versionDir, entry.path);
  const text = await readTextFile(filePath);
  const frontmatter = parseRuleFrontmatter(text);
  return {
    path: entry.path,
    order: entry.order,
    text,
    ...(frontmatter.constraint !== undefined ? { constraint: frontmatter.constraint } : {}),
  };
}

/** 解析 MCP 配置：mcp.json 的 name + 其余字段原样透传。name 非字符串抛 GroupContentLoadError。 */
async function loadMcp(versionDir: string, relPath: string): Promise<LoadedMcp> {
  const filePath = join(versionDir, relPath);
  const parsed = await readJsonFile(filePath);
  if (!isRecord(parsed)) {
    throw new GroupContentLoadError(filePath, "mcp.json 根节点必须是 JSON 对象");
  }
  if (typeof parsed.name !== "string") {
    throw new GroupContentLoadError(filePath, "mcp.json 字段 name 必须为字符串");
  }
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key !== "name") {
      config[key] = value;
    }
  }
  return { name: parsed.name, config, path: relPath };
}

/**
 * 加载功能组指定版本的内容文件。版本不存在抛 GroupContentLoadError；内容文件缺失/非法抛 GroupContentLoadError（含路径）。
 * 版本目录路径 = rootDir/<namespace>/v<version>（对齐 release.ts 惯例）。
 */
export async function loadGroupContent(
  rootDir: string,
  group: CapabilityGroup,
  version: string,
): Promise<LoadedGroupContent> {
  const versionDir = join(rootDir, ...group.namespace.split("/"), `v${version}`);
  const versionSnapshot = loadVersion(group, version);
  if (versionSnapshot === undefined) {
    throw new GroupContentLoadError(versionDir, `版本 ${version} 不存在`);
  }
  const content = versionSnapshot.content;

  // agent：单文件可选；content 无 agent 或文件缺失（空目录）→ agent 字段省略。
  const agentText = content.agent === undefined ? undefined : await readOptionalTextFile(join(versionDir, content.agent));
  const agent = agentText === undefined ? undefined : { text: agentText };

  const tools: LoadedTool[] = [];
  for (const relPath of content.tools) {
    tools.push(await loadTool(versionDir, relPath));
  }
  const rules: LoadedRule[] = [];
  for (const entry of content.rules) {
    rules.push(await loadRule(versionDir, entry));
  }
  const mcps: LoadedMcp[] = [];
  for (const relPath of content.mcps) {
    mcps.push(await loadMcp(versionDir, relPath));
  }

  return {
    guid: group.guid,
    namespace: group.namespace,
    version,
    ...(agent !== undefined ? { agent } : {}),
    tools,
    rules,
    mcps,
  };
}
