// IPC 通道与跨进程共享类型（纯类型模块：无 electron/node/核心库依赖，renderer/main/preload 三方复用）。
// 端口元数据只取 id/name/type（binding 等运行期内容不进 IPC）。
// 参数面板字段为核心库 ParamField 的可序列化镜像：核心 ParamField 定义于 node 侧 execution/types.ts，
// IPC 边界不直接引用它，避免 renderer 侧 tsconfig 把 node 依赖链拉进 DOM 环境。

/** 参数面板字段类型（镜像核心库 execution/types.ts 的 ParamFieldType） */
export type ParamFieldMetadataType = "string" | "number" | "boolean" | "select" | "textarea" | "json";

/** 参数面板字段元数据（镜像核心库 ParamField 的可序列化形状） */
export interface ParamFieldMetadata {
  readonly key: string;
  readonly label: string;
  readonly type: ParamFieldMetadataType;
  readonly default?: unknown;
  readonly required?: boolean;
  readonly description?: string;
  readonly placeholder?: string;
  readonly options?: readonly { readonly label: string; readonly value: string }[];
}

/** IPC 通道名常量 */
export const IPC = {
  listNodeTypes: "editor:listNodeTypes",
  workflowNew: "workflow:new",
  workflowOpen: "workflow:open",
  workflowSaveAs: "workflow:saveAs",
  workflowSave: "workflow:save",
} as const;

/** 端口元数据（可序列化子集） */
export interface PortMetadata {
  readonly id: string;
  readonly name: string;
  readonly type: string;
}

/** 节点类型元数据：物料面板（类型列表）与配置面板（paramsSchema）共用 */
export interface NodeTypeMetadata {
  readonly type: string;
  readonly name: string;
  readonly idempotent: boolean;
  readonly inputs: readonly PortMetadata[];
  readonly outputs: readonly PortMetadata[];
  readonly paramsSchema: readonly ParamFieldMetadata[] | undefined;
}

/** 工作流文件数据（镜像核心 workflowSchema 的可序列化形状；运行期经核心库校验，IPC 边界不直接引用核心库） */
export interface WorkflowFileData {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly nodes: readonly unknown[];
  readonly edges: readonly unknown[];
}

/** 新建工作流的空模板（workflow:new 返回） */
export type WorkflowTemplate = WorkflowFileData;

/** workflow:open 返回：用户取消返回 canceled；成功返回文件路径与已校验的 WorkflowJSON */
export type OpenWorkflowResponse =
  | { readonly canceled: true }
  | { readonly filePath: string; readonly workflow: WorkflowFileData };

/** workflow:saveAs 返回：用户取消返回 canceled；成功返回最终写入路径 */
export type SaveAsWorkflowResponse = { readonly canceled: true } | { readonly filePath: string };

/** workflow:save 返回 */
export interface SaveWorkflowResult {
  readonly ok: true;
}

/** workflow:saveAs 载荷：workflow 待保存数据；suggestedName 为对话框默认文件名（可选） */
export interface SaveAsWorkflowPayload {
  readonly workflow: unknown;
  readonly suggestedName?: string;
}

/** workflow:save 载荷：filePath 为已打开文件路径，直接覆盖保存 */
export interface SaveWorkflowPayload {
  readonly filePath: string;
  readonly workflow: unknown;
}

/** preload 通过 contextBridge 暴露给渲染进程的 API 形状 */
export interface HnflowApi {
  readonly version: string;
  readonly platform: string;
  listNodeTypes(): Promise<readonly NodeTypeMetadata[]>;
  newWorkflow(): Promise<WorkflowTemplate>;
  openWorkflow(): Promise<OpenWorkflowResponse>;
  saveAsWorkflow(workflow: unknown, suggestedName?: string): Promise<SaveAsWorkflowResponse>;
  saveWorkflow(filePath: string, workflow: unknown): Promise<SaveWorkflowResult>;
}
