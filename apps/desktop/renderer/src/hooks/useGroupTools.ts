// useGroupTools：功能组工具物料（v0.4.3 验收 1/2）。
// - 拉取 window.hnflow.listGroups()，按命名空间组装物料分组（buildGroupItems 纯函数可单测）；
// - 每个功能组的 MCP server（config.command 为 string 即可执行）生成一个 bound=true 的 MCP 物料，
//   拖拽/点击生成 mcpTool 节点：params = { serverName, toolName: "", mcpConfig, args: {} }，
//   具体工具名由用户在参数面板填写（工具动态发现是运行期 AI 节点职责，面板与发现解耦）；
// - 声明工具（GroupToolSummary）面板无代码 handler 绑定信息，统一 bound=false 灰显「未绑定」。

import { useEffect, useState } from "react";
import type { EditorGraphNode } from "@core/editing/editor-graph";
import type { GroupSummary } from "../../../src/shared/ipc.js";
import type { GraphPosition } from "../editor/ports.js";
import { createNodeId } from "./useNodeCreation.js";

/** 物料条目：MCP（bound=true，可拖拽）或声明工具（bound=false，未绑定灰显）。 */
export interface GroupToolItem {
  readonly kind: "mcp" | "declared";
  readonly name: string;
  readonly description: string;
  /** 仅 MCP 物料有值（mcpTool 节点 serverName 参数）；声明工具为 undefined。 */
  readonly serverName: string | undefined;
  /** 仅 MCP 物料有值；本版本留空，用户在参数面板填写工具名。 */
  readonly toolName: string | undefined;
  /** 仅 MCP 物料有值：MCP server 配置快照（command 已确认可执行）。 */
  readonly mcpConfig: Readonly<Record<string, unknown>> | undefined;
  readonly bound: boolean;
}

/** 物料分组：一个功能组命名空间一个分组。 */
export interface GroupToolGroup {
  readonly key: string;
  readonly label: string;
  readonly items: readonly GroupToolItem[];
}

/** 可执行判定：config.command 为字符串（其余字段运行期由 mcpTool 节点边界解析）。 */
function hasExecutableCommand(config: Readonly<Record<string, unknown>>): boolean {
  return typeof config["command"] === "string";
}

/** 功能组摘要列表 → 物料分组数组（纯函数，单测覆盖）。 */
export function buildGroupItems(groups: readonly GroupSummary[]): readonly GroupToolGroup[] {
  return groups.map((group) => ({
    key: `group:${group.namespace}`,
    label: group.namespace,
    items: [
      ...group.mcps
        .filter((mcp) => hasExecutableCommand(mcp.config))
        .map((mcp) => ({
          kind: "mcp" as const,
          name: mcp.name,
          description: "MCP Server（工具动态发现）",
          serverName: mcp.name,
          toolName: "",
          mcpConfig: { ...mcp.config },
          bound: true,
        })),
      ...group.tools.map((tool) => ({
        kind: "declared" as const,
        name: tool.name,
        description: tool.description,
        serverName: undefined,
        toolName: undefined,
        mcpConfig: undefined,
        bound: false,
      })),
    ],
  }));
}

/** MCP 物料 → mcpTool 节点（toolName 留空由参数面板填写；非 MCP 物料抛错防御）。 */
export function buildMcpToolNode(item: GroupToolItem, position: GraphPosition): EditorGraphNode {
  if (item.kind !== "mcp" || item.serverName === undefined || item.mcpConfig === undefined) {
    throw new Error("非 MCP 物料不能生成 mcpTool 节点");
  }
  return {
    id: createNodeId("mcpTool"),
    type: "mcpTool",
    name: `MCP 工具调用（${item.serverName}）`,
    params: { serverName: item.serverName, toolName: "", mcpConfig: { ...item.mcpConfig }, args: {} },
    inputs: [],
    outputs: [{ id: "result", name: "result", type: "string", direction: "out" }],
    position,
  };
}

/** 功能组物料加载状态（与 useNodeTypeMetadata 同构：undefined=加载中，failed=拉取失败）。 */
export interface GroupToolsState {
  readonly groups: readonly GroupToolGroup[] | undefined;
  readonly failed: boolean;
}

/** React hook：拉取功能组并组装物料（卸载安全；失败置 failed=true）。 */
export function useGroupTools(): GroupToolsState {
  const [groups, setGroups] = useState<readonly GroupToolGroup[] | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    window.hnflow
      .listGroups()
      .then((list) => {
        if (!cancelled) {
          setGroups(buildGroupItems(list));
        }
      })
      .catch((error: unknown) => {
        console.error("功能组工具加载失败", error);
        if (!cancelled) {
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return { groups, failed };
}
