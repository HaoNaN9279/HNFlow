// useNodeCreation：物料面板「节点工厂 + 元数据加载」（T6）。
// - 节点类型元数据经 window.hnflow.listNodeTypes() 获取，模块级缓存保证面板/配置区只拉一次；
// - createDefaultNode：NodeTypeMetadata → EditorGraphNode（默认参数从 paramsSchema 取 default，
//   端口按 in/out 方向补齐核心 Port 结构），供拖拽/点击创建统一消费。

import { useEffect, useState } from "react";
import type { EditorGraphNode } from "@core/editing/editor-graph";
import type { PortType } from "@core/model/types";
import type { NodeTypeMetadata, ParamFieldMetadata, PortMetadata } from "../../../src/shared/ipc.js";
import type { GraphPosition } from "../editor/ports.js";

/** 合法端口类型集合（PortMetadata.type 为 string，需窄化为核心 PortType）。 */
const PORT_TYPE_SET = new Set<PortType>(["string", "number", "boolean", "any"]);

/** 端口类型窄化：未知类型防御性回落 "any"。 */
function toPortType(type: string): PortType {
  return PORT_TYPE_SET.has(type as PortType) ? (type as PortType) : "any";
}

/** 节点 id：`${type}-${时间戳36进制}`（拖拽/点击创建共用）。 */
export function createNodeId(type: string): string {
  return `${type}-${Date.now().toString(36)}`;
}

/** 默认参数：从 paramsSchema 各字段 default 提取；无 schema 为空对象。 */
export function createDefaultParams(
  schema: readonly ParamFieldMetadata[] | undefined,
): Readonly<Record<string, unknown>> {
  if (schema === undefined) {
    return {};
  }
  const params: Record<string, unknown> = {};
  for (const field of schema) {
    if (field.default !== undefined) {
      params[field.key] = field.default;
    }
  }
  return params;
}

/** 端口元数据 → 核心 Port（direction 由 in/out 分组决定）。 */
function portToCore(port: PortMetadata, direction: "in" | "out"): {
  readonly id: string;
  readonly name: string;
  readonly type: PortType;
  readonly direction: "in" | "out";
} {
  return { id: port.id, name: port.name, type: toPortType(port.type), direction };
}

/** 由节点类型元数据构造默认 EditorGraphNode（端口从 metadata inputs/outputs 建 Port[]）。 */
export function createDefaultNode(
  type: string,
  metadata: NodeTypeMetadata,
  position: GraphPosition,
): EditorGraphNode {
  return {
    id: createNodeId(type),
    type,
    name: metadata.name,
    params: createDefaultParams(metadata.paramsSchema),
    inputs: metadata.inputs.map((port) => portToCore(port, "in")),
    outputs: metadata.outputs.map((port) => portToCore(port, "out")),
    position,
  };
}

/** 模块级元数据缓存：listNodeTypes 整个会话只拉一次。 */
let metadataPromise: Promise<readonly NodeTypeMetadata[]> | undefined;

/** 拉取节点类型元数据（幂等缓存，返回同一 Promise）。 */
export function loadNodeTypeMetadata(): Promise<readonly NodeTypeMetadata[]> {
  metadataPromise ??= window.hnflow.listNodeTypes();
  return metadataPromise;
}

/** 元数据加载状态：failed 标记 IPC 拉取失败（面板据此区分加载中/失败，避免永久转圈）。 */
export interface NodeTypeMetadataState {
  readonly metadata: readonly NodeTypeMetadata[] | undefined;
  readonly failed: boolean;
}

/** React hook：异步加载节点类型元数据（卸载安全；失败置 failed=true）。 */
export function useNodeTypeMetadata(): NodeTypeMetadataState {
  const [metadata, setMetadata] = useState<readonly NodeTypeMetadata[] | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadNodeTypeMetadata()
      .then((list) => {
        if (!cancelled) {
          setMetadata(list);
        }
      })
      .catch((error: unknown) => {
        console.error("节点类型元数据加载失败", error);
        if (!cancelled) {
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return { metadata, failed };
}
