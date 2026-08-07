// 功能组库种子（首次启动写入 userData/groups 的内容）。
// 同步自 tests/fixtures/groups/demo-group，修改需两处同步。
// 结构 = group.json 元数据（guid/namespace/versions/currentVersion）+ versionContent（版本号 → 内容对象），
// 写盘时展开为目录布局：<namespace>/group.json + v<version>/（agent.md / tools/*.json / mcp-*.json / rules/*.md）。

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 单个种子工具：声明式描述，写盘展开为 tools/<name>.json。 */
export interface SeedTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>; // JSON schema
}

/** 单个种子 MCP：name + 其余配置原样透传，写盘展开为 mcp-<name>.json。 */
export interface SeedMcp {
  readonly name: string;
  readonly config: Readonly<Record<string, unknown>>;
}

/** 单个种子版本内容：agent 为 agent.md 文本；tools/mcps 为内嵌对象数组；rules 为规则文本数组。 */
export interface SeedVersionContent {
  readonly agent?: string; // agent.md 文本；写盘展开为 v<version>/agent.md（group.json content 不声明 agent，与夹具一致）
  readonly tools: readonly SeedTool[];
  readonly rules?: readonly string[]; // 规则文本，写盘展开为 v<version>/rules/<序号>.md
  readonly mcps?: readonly SeedMcp[];
}

/** 单个种子功能组：group.json 元数据 + 各版本内容。 */
export interface SeedGroup {
  readonly guid: string;
  readonly namespace: string;
  readonly description: string;
  readonly versions: readonly { readonly version: string; readonly createdAt: string; readonly changelog: string }[];
  readonly currentVersion: string;
  readonly versionContent: Readonly<Record<string, SeedVersionContent>>;
}

/** 种子功能组集（demo 演示 + web/scraping、data/processing、code/review 三个领域功能组）。 */
export const SEED_GROUPS: readonly SeedGroup[] = [
  {
    guid: "9d3f7b2e-5c8a-4f1e-9d2b-7c4e8a1f6b3d",
    namespace: "demo",
    description: "演示功能组：展示功能组命名空间分组与工具声明扫描汇总",
    versions: [{ version: "1.0.0", createdAt: "2026-08-01T08:00:00.000Z", changelog: "初始版本" }],
    currentVersion: "1.0.0",
    versionContent: {
      "1.0.0": {
        agent:
          "# 演示功能组\n\n我是演示功能组，负责展示功能组命名空间分组与工具声明扫描汇总。当前版本未在 group.json 中声明启用 agent。",
        tools: [
          {
            name: "echo_tool",
            description: "演示工具：回显文本",
            parameters: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
        rules: [],
        mcps: [],
      },
    },
  },
  {
    guid: "3f8c1d2a-9b4e-4a7f-8c3d-5e2b6f9a1c4d",
    namespace: "web/scraping",
    description: "网页抓取领域助手：抓取网页内容、提取链接，遵守抓取频率与 robots 协议",
    versions: [{ version: "1.0.0", createdAt: "2026-08-07T08:00:00.000Z", changelog: "初始版本" }],
    currentVersion: "1.0.0",
    versionContent: {
      "1.0.0": {
        agent:
          "# 网页抓取领域助手\n\n我是网页抓取领域助手，负责抓取网页内容并提取链接。我会优先遵守目标站点的 robots 协议与合理抓取频率，避免对站点造成压力。",
        tools: [
          {
            name: "fetch_page",
            description: "抓取网页内容，返回页面文本与状态信息",
            parameters: {
              type: "object",
              properties: {
                url: { type: "string", description: "目标网页完整地址（含协议），如 https://example.com/page" },
                timeout_ms: { type: "number", description: "请求超时毫秒数，默认 10000", minimum: 1000 },
                include_html: { type: "boolean", description: "是否同时返回原始 HTML，默认 false" },
              },
              required: ["url"],
            },
          },
          {
            name: "extract_links",
            description: "从 HTML 源码中提取链接列表，支持按基础地址解析相对链接",
            parameters: {
              type: "object",
              properties: {
                html: { type: "string", description: "网页 HTML 源码" },
                base_url: { type: "string", description: "基础地址，用于将相对链接转为绝对链接" },
                filter: { type: "string", description: "仅保留包含该子串的链接，省略则返回全部" },
              },
              required: ["html"],
            },
          },
        ],
        rules: [
          "抓取频率与 robots 遵守规则：每个域名连续请求间隔至少 1 秒；优先解析并遵守目标站点 robots.txt 的 Disallow 规则；对返回 429/503 的站点立即停止并等待重试窗口；同一批次任务完成后等待至少 5 秒再发起下一批。",
        ],
        mcps: [],
      },
    },
  },
  {
    guid: "5e7a9c2b-8d4f-4b3a-9e6c-2f8d1a7b3e5f",
    namespace: "data/processing",
    description: "数据处理领域助手：数据归一化与结构校验，保证下游数据质量",
    versions: [{ version: "1.0.0", createdAt: "2026-08-07T08:00:00.000Z", changelog: "初始版本" }],
    currentVersion: "1.0.0",
    versionContent: {
      "1.0.0": {
        agent:
          "# 数据处理领域助手\n\n我是数据处理领域助手，负责数据的归一化与结构校验。我会在加工前先校验输入结构，加工后复核结果，确保数据满足下游消费要求。",
        tools: [
          {
            name: "normalize_data",
            description: "归一化数据集：去空白、统一字段命名与缺失值策略",
            parameters: {
              type: "object",
              properties: {
                data: { type: "array", description: "待归一化的记录数组", items: { type: "object" } },
                null_strategy: {
                  type: "string",
                  description: "缺失值处理策略",
                  enum: ["drop", "empty", "zero", "keep"],
                },
                trim_strings: { type: "boolean", description: "是否去除字符串字段首尾空白，默认 true" },
              },
              required: ["data"],
            },
          },
          {
            name: "validate_schema",
            description: "校验数据是否符合声明的结构 schema，返回字段级错误列表",
            parameters: {
              type: "object",
              properties: {
                data: { type: "object", description: "待校验的数据对象" },
                schema: { type: "object", description: "JSON Schema 结构声明" },
                strict: { type: "boolean", description: "严格模式：未知字段视为错误，默认 false" },
              },
              required: ["data", "schema"],
            },
          },
        ],
        rules: [
          "数据质量规则：输入数据必须先经 validate_schema 校验通过方可加工；归一化不允许静默丢弃数据，drop 策略需在结果中报告被丢弃的记录数；字段命名统一为 snake_case；字符串字段默认去除首尾空白；加工完成输出必须附带数据行数与质量报告。",
        ],
        mcps: [],
      },
    },
  },
  {
    guid: "7c9b1e3d-2f5a-4b6c-8d7e-9a1c3f5b7d2e",
    namespace: "code/review",
    description: "代码审查领域助手：静态问题扫描与风格检查，产出可操作修改建议",
    versions: [{ version: "1.0.0", createdAt: "2026-08-07T08:00:00.000Z", changelog: "初始版本" }],
    currentVersion: "1.0.0",
    versionContent: {
      "1.0.0": {
        agent:
          "# 代码审查领域助手\n\n我是代码审查领域助手，负责对代码做静态问题扫描与风格检查。我按严重程度分级报告问题，并给出具体可操作的修改建议。",
        tools: [
          {
            name: "scan_issues",
            description: "静态扫描代码文件，报告潜在缺陷与危险模式",
            parameters: {
              type: "object",
              properties: {
                files: { type: "array", description: "待扫描的文件路径列表", items: { type: "string" } },
                severity: {
                  type: "string",
                  description: "最低报告级别",
                  enum: ["error", "warning", "info"],
                },
              },
              required: ["files"],
            },
          },
          {
            name: "check_style",
            description: "按指定配置文件检查代码风格，返回违反项列表",
            parameters: {
              type: "object",
              properties: {
                files: { type: "array", description: "待检查的文件路径列表", items: { type: "string" } },
                config_path: { type: "string", description: "风格配置文件的路径，省略则使用默认配置" },
              },
              required: ["files"],
            },
          },
        ],
        rules: [
          "审查规则：问题按 error/warning/info 分级报告，error 必须附建议修复方式；每个问题须给出文件、行号与原因说明；风格检查与静态扫描并行执行，最终汇总为按文件分组的报告；审查结果不直接修改源码，只输出建议。",
        ],
        mcps: [],
      },
    },
  },
];

/** 展开单版本内容为 group.json 的 content 字段（tools/mcps/rules 路径引用；agent 不声明，与夹具一致）。 */
function buildGroupContent(seed: SeedGroup, version: string): {
  readonly tools: readonly string[];
  readonly mcps: readonly string[];
  readonly rules: readonly { readonly path: string; readonly order: number }[];
} {
  const versionContent = seed.versionContent[version];
  if (versionContent === undefined) {
    throw new Error(`种子功能组 "${seed.namespace}" 缺少版本 ${version} 的内容`);
  }
  return {
    tools: versionContent.tools.map((tool) => `tools/${tool.name}.json`),
    mcps: (versionContent.mcps ?? []).map((mcp) => `mcp-${mcp.name}.json`),
    rules: (versionContent.rules ?? []).map((_rule, index) => ({ path: `rules/${index}.md`, order: index })),
  };
}

/** 写单个种子功能组：先写各版本 v<version>/ 内容文件，再写 group.json（元数据）。 */
export async function writeSeedGroup(root: string, seed: SeedGroup): Promise<void> {
  const groupDir = join(root, ...seed.namespace.split("/"));
  await mkdir(groupDir, { recursive: true });
  for (const version of seed.versions) {
    const versionContent = seed.versionContent[version.version];
    if (versionContent === undefined) {
      throw new Error(`种子功能组 "${seed.namespace}" 缺少版本 ${version.version} 的内容`);
    }
    const versionDir = join(groupDir, `v${version.version}`);
    await mkdir(versionDir, { recursive: true });
    if (versionContent.agent !== undefined) {
      await writeFile(join(versionDir, "agent.md"), `${versionContent.agent}\n`, "utf8");
    }
    for (const tool of versionContent.tools) {
      const toolsDir = join(versionDir, "tools");
      await mkdir(toolsDir, { recursive: true });
      await writeFile(
        join(toolsDir, `${tool.name}.json`),
        `${JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }, null, 2)}\n`,
        "utf8",
      );
    }
    for (const mcp of versionContent.mcps ?? []) {
      await writeFile(
        join(versionDir, `mcp-${mcp.name}.json`),
        `${JSON.stringify({ name: mcp.name, ...mcp.config }, null, 2)}\n`,
        "utf8",
      );
    }
    for (const [index, rule] of (versionContent.rules ?? []).entries()) {
      const rulesDir = join(versionDir, "rules");
      await mkdir(rulesDir, { recursive: true });
      await writeFile(join(rulesDir, `${index}.md`), rule, "utf8");
    }
  }
  const groupJson = {
    guid: seed.guid,
    namespace: seed.namespace,
    aliases: [],
    description: seed.description,
    currentVersion: seed.currentVersion,
    versions: seed.versions.map((version) => ({
      version: version.version,
      createdAt: version.createdAt,
      changelog: version.changelog,
      content: buildGroupContent(seed, version.version),
    })),
  };
  await writeFile(join(groupDir, "group.json"), `${JSON.stringify(groupJson, null, 2)}\n`, "utf8");
}
