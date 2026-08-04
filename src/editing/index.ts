// 编辑态纯函数：只读态查询、草稿创建（深拷贝隔离）、草稿提交（校验 + 继承原图元信息）。
// 通过 EngineStateQuery 最小接口消费引擎状态，避免直接依赖 ExecutionEngine。
// 深拷贝复用公共 utils/deepCopy（含嵌套 subworkflow）。
import type { Workflow } from "../model/types.js";
import { validateWorkflow } from "../model/validate.js";
import { deepCopyWorkflow } from "../utils/deepCopy.js";

/** 引擎状态查询最小接口：供 isReadOnly/workflowSnapshot 消费，避免直接依赖 ExecutionEngine。 */
export interface EngineStateQuery {
  readonly isReadOnly: boolean;
  readonly workflowSnapshot: Workflow;
}

/** 草稿工作流：在 Workflow 基础上强制携带 draftOf 溯源字段。 */
export interface Draft extends Workflow {
  readonly draftOf: string;
}

/** 草稿提交失败：draftOf 与 original 不匹配，或 draft 校验不通过。 */
export class DraftCommitError extends Error {
  readonly name = "DraftCommitError";

  constructor(readonly reason: string) {
    super(reason);
  }
}

/** 只读态查询：引擎只读时不响应编辑操作。 */
export function isReadOnly(engine: EngineStateQuery): boolean {
  return engine.isReadOnly;
}

/** 当前工作流快照：引擎负责不可变深拷贝，本函数透传。 */
export function workflowSnapshot(engine: EngineStateQuery): Workflow {
  return engine.workflowSnapshot;
}

/** 创建草稿：深拷贝原图（含嵌套 subworkflow），打上 -draft 标记与 draftOf 溯源。 */
export function createDraft(workflow: Workflow): Draft {
  const copy = deepCopyWorkflow(workflow);
  return {
    ...copy,
    id: `${workflow.id}-draft`,
    version: `draft-${Date.now()}`,
    draftOf: workflow.id,
  };
}

/**
 * 提交草稿：校验 draftOf 匹配与图合法（含嵌套子图递归校验），
 * 返回继承 original 元信息、内容取自 draft、无 draftOf 的新 Workflow。
 */
export function commitDraft(draft: Draft, original: Workflow): Workflow {
  if (draft.draftOf !== original.id) {
    throw new DraftCommitError(
      `draft.draftOf (${draft.draftOf}) 与 original.id (${original.id}) 不匹配`,
    );
  }
  const result = validateWorkflow(draft);
  if (!result.ok) {
    throw new DraftCommitError(`draft 校验失败: ${result.errors.join("; ")}`);
  }
  const copy = deepCopyWorkflow(draft);
  return {
    id: original.id,
    name: original.name,
    version: original.version,
    nodes: copy.nodes,
    edges: copy.edges,
    ...(copy.globalVariables === undefined ? {} : { globalVariables: copy.globalVariables }),
  };
}
