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

/** 种子功能组集（当前仅演示功能组 demo）。 */
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
