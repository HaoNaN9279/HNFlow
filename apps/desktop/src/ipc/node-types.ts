// 节点类型元数据：核心库 builtinNodes → 可序列化元数据（物料面板/配置面板消费）。

import type { INodeDefinition, ParamField } from "../../../../src/execution/types.js";
import type { Port } from "../../../../src/model/types.js";
import { builtinNodes } from "../../../../src/nodes/registry.js";
import type { NodeTypeMetadata, ParamFieldMetadata, PortMetadata } from "../shared/ipc.js";

/** 端口只取 id/name/type（binding 等运行期内容不进 IPC） */
function portToMetadata(port: Port): PortMetadata {
  return { id: port.id, name: port.name, type: port.type };
}

/** 核心 ParamField → IPC 可序列化元数据（显式重建，保持 IPC 边界无核心运行时引用） */
function paramFieldToMetadata(field: ParamField): ParamFieldMetadata {
  return {
    key: field.key,
    label: field.label,
    type: field.type,
    ...(field.default === undefined ? {} : { default: field.default }),
    ...(field.required === undefined ? {} : { required: field.required }),
    ...(field.description === undefined ? {} : { description: field.description }),
    ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
    ...(field.options === undefined ? {} : { options: field.options }),
  };
}

/** 节点定义 → 元数据：idempotent 缺省视为 true；paramsSchema 缺省为 undefined */
function definitionToMetadata(def: INodeDefinition): NodeTypeMetadata {
  return {
    type: def.type,
    name: def.name,
    idempotent: def.idempotent ?? true,
    inputs: def.inputs.map(portToMetadata),
    outputs: def.outputs.map(portToMetadata),
    paramsSchema: def.paramsSchema === undefined ? undefined : def.paramsSchema.map(paramFieldToMetadata),
  };
}

/** 全部内置节点类型的元数据列表（editor:listNodeTypes 通道返回） */
export function listNodeTypeMetadata(): readonly NodeTypeMetadata[] {
  return builtinNodes.map(definitionToMetadata);
}
