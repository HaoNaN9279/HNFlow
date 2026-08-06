// agent 模块聚合导出：工作流生成器核心 + 工具工厂。
export {
  availableNodeKinds,
  createGenerateWorkflowTool,
  generateWorkflowFromPlan,
  GENERATABLE_NODE_TYPES,
  WorkflowGenerationError,
  workflowPlanSchema,
} from "./workflow-generator.js";
export type { WorkflowPlan } from "./workflow-generator.js";
