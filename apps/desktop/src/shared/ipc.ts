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
  workflowRun: "workflow:run",
  workflowReviewRequest: "workflow:review-request",
  workflowReviewDecision: "workflow:review-decision",
  agentChat: "agent:chat",
  templateList: "template:list",
  templateLoadVersion: "template:loadVersion",
  templateRelease: "template:release",
  groupList: "group:list",
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

/** workflow:run 载荷：workflow 为当前画布的可序列化形状（main 侧经核心 workflowSchema 校验） */
export interface RunWorkflowPayload {
  readonly workflow: unknown;
}

/** 引擎运行日志条目（镜像核心库 src/execution/engine-util.ts 的 EngineLogEntry，IPC 边界不直接引用核心库） */
export interface IpcLogEntry {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly data: unknown | undefined;
}

/** 运行期变量快照：global 为全局上下文；workflow 为工作流上下文；node 为各节点执行上下文（key 为 `node:<id>`） */
export interface DebugContextSnapshot {
  readonly global: Record<string, unknown>;
  readonly workflow: Record<string, unknown>;
  readonly node: Record<string, Record<string, unknown>>;
}

/** 节点运行状态（镜像核心库 src/execution/NodeState.ts 的 NodeStatus，IPC 边界不直接引用核心库） */
export type DebugNodeStatus = "Idle" | "Running" | "Success" | "Failed" | "Skipped" | "WaitingForHuman" | "Paused";

/** 单次运行调试信息（成功运行时附带；main 侧在 run.ts 组装，IPC 边界仅承载可序列化形状） */
export interface RunDebugInfo {
  readonly runId: string;
  readonly nodeStates: Record<string, DebugNodeStatus>;
  readonly nodeOutputs: Record<string, Record<string, unknown>>;
  readonly contextSnapshot: DebugContextSnapshot;
  readonly logs: readonly IpcLogEntry[];
  readonly startTime: number;
  readonly endTime: number;
}

/** workflow:run 返回：内存单次运行结果（成功带 runId；失败带中文消息与失败节点信息）。成功/失败分支均可附带 debug 调试信息（向后兼容，旧调用方只读 ok/runId/message 不受影响）。 */
export type RunWorkflowResult =
  | { readonly ok: true; readonly runId: string; readonly debug?: RunDebugInfo }
  | {
      readonly ok: false;
      readonly message: string;
      readonly nodeId?: string;
      readonly nodePath?: string;
      readonly debug?: RunDebugInfo;
    };

/** 审核请求信息（main → renderer 事件 workflow:review-request 载荷；运行到待审核 command 节点时触发）。 */
export interface ReviewRequestInfo {
  readonly requestId: string;
  readonly nodeId: string;
  readonly description: string;
}

/** workflow:review-decision 载荷：renderer 提交审核决策（批准执行 / 拒绝跳过）。 */
export interface ReviewDecisionPayload {
  readonly requestId: string;
  readonly decision: "approve" | "reject";
}

/** workflow:review-decision 返回：决策已提交（requestId 已超时清理时幂等返回）。 */
export interface ReviewDecisionResult {
  readonly ok: true;
}

/** 模板摘要（template:list 返回项） */
export interface TemplateSummary {
  readonly name: string;
  readonly description: string;
  readonly currentVersion: string;
  /** 版本历史（降序或升序均可，含 changelog） */
  readonly versions: readonly { readonly version: string; readonly createdAt: string; readonly changelog: string }[];
  readonly interface: { readonly inputs: readonly string[]; readonly outputs: readonly string[] };
}

/** template:loadVersion 载荷：模板名 + 版本号（缺省 currentVersion） */
export interface LoadTemplateVersionPayload {
  readonly name: string;
  readonly version?: string;
}

/** template:loadVersion 返回：该版本 workflow 的可序列化形状（nodes/edges 全量） */
export interface LoadTemplateVersionResponse {
  readonly name: string;
  readonly version: string;
  readonly workflow: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly nodes: readonly unknown[];
    readonly edges: readonly unknown[];
  };
}

/** template:release 载荷：发布新版本（name + newVersion + changelog + workflow 内容） */
export interface ReleaseTemplatePayload {
  readonly name: string;
  readonly newVersion: string;
  readonly changelog?: string;
  readonly workflow: unknown; // Workflow 可序列化形状，main 侧经核心校验
}

/** template:release 返回：发布后模板摘要 */
export type ReleaseTemplateResponse = TemplateSummary;

/** 功能组工具摘要（group:list 返回项：工具声明名称与描述） */
export interface GroupToolSummary {
  readonly name: string;
  readonly description: string;
}

/** 功能组 MCP 摘要（group:list 返回项：MCP 名称 + 配置原样透传） */
export interface GroupMcpSummary {
  readonly name: string;
  readonly config: Readonly<Record<string, unknown>>;
}

/** 功能组摘要（group:list 返回项：命名空间 + 当前版本 + 当前版本内容汇总） */
export interface GroupSummary {
  readonly namespace: string;
  readonly currentVersion: string;
  readonly tools: readonly GroupToolSummary[];
  readonly mcps: readonly GroupMcpSummary[];
  /** 版本历史摘要（镜像核心 GroupVersion 的可序列化子集，含废弃标记） */
  readonly versions: readonly {
    readonly version: string;
    readonly createdAt: string;
    readonly changelog: string;
    readonly deprecated?: boolean;
  }[];
}

/** AI 对话消息（agent:chat 载荷：镜像核心 InputMessage 形状）。 */
export interface AgentChatMessage {
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
}

/** agent:chat 模型配置（核心 ModelConfig 可序列化子集；fakeScript 不跨 IPC，fake 由 main 侧注入固定脚本）。 */
export interface AgentChatModelConfig {
  readonly provider: string;
  readonly model?: string;
  readonly apiKey?: string;
  readonly baseURL?: string;
}

/** agent:chat 载荷：消息序列 + 模型配置。 */
export interface AgentChatPayload {
  readonly messages: readonly AgentChatMessage[];
  readonly model: AgentChatModelConfig;
}

/** agent:chat 返回：ok 时带回复文本；生成成功时附 workflow（main 已校验）与摘要。 */
export type AgentChatResult =
  | { readonly ok: true; readonly reply: string; readonly workflow?: unknown; readonly summary?: string }
  | { readonly ok: false; readonly message: string };

/** preload 通过 contextBridge 暴露给渲染进程的 API 形状 */
export interface HnflowApi {
  readonly version: string;
  readonly platform: string;
  listNodeTypes(): Promise<readonly NodeTypeMetadata[]>;
  newWorkflow(): Promise<WorkflowTemplate>;
  openWorkflow(): Promise<OpenWorkflowResponse>;
  saveAsWorkflow(workflow: unknown, suggestedName?: string): Promise<SaveAsWorkflowResponse>;
  saveWorkflow(filePath: string, workflow: unknown): Promise<SaveWorkflowResult>;
  runWorkflow(payload: RunWorkflowPayload): Promise<RunWorkflowResult>;
  /** 提交审核决策（批准执行 / 拒绝跳过）；requestId 对应 workflow:review-request 事件载荷。 */
  sendReviewDecision(payload: ReviewDecisionPayload): Promise<ReviewDecisionResult>;
  /** 订阅审核请求事件（运行到待审核 command 节点时触发）；返回取消订阅函数。 */
  onReviewRequest(cb: (request: ReviewRequestInfo) => void): () => void;
  chatWithAgent(payload: AgentChatPayload): Promise<AgentChatResult>;
  listTemplates(): Promise<readonly TemplateSummary[]>;
  loadTemplateVersion(payload: LoadTemplateVersionPayload): Promise<LoadTemplateVersionResponse>;
  releaseTemplate(payload: ReleaseTemplatePayload): Promise<ReleaseTemplateResponse>;
  listGroups(): Promise<readonly GroupSummary[]>;
}
