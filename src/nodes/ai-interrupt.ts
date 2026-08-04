// ai 节点 interrupt 参数解析：静态工具级审批配置（v0.2.1 不支持 when，when 由代码注入）。
// 独立成模块保持 ai.ts ≤250 LOC；非法参数经错误构造器回调，由 ai 节点统一抛 InvalidAIParamsError。
import type { AIInterruptConfig } from "../ai/executor.js";
import type { HNFlowTool } from "../ai/types.js";

/** interrupt 参数：true 表示全部工具默认审批（execute 时按已解析工具展开）；对象为工具级静态配置。 */
export type InterruptParam = AIInterruptConfig | true;

/** 非法参数错误构造器：调用方（ai 节点）传入类型化错误类。 */
export type InterruptErrorCtor = new (params: unknown, reason: string) => Error;

/** interruptOn 静态条目（when 由代码注入，v0.2.1 不从 params 配置）。 */
interface InterruptEntry {
  readonly allowedDecisions?: readonly ("approve" | "reject")[];
  readonly description?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 解析 interrupt：undefined → 缺省；true → 全部工具审批标记；对象 → 严格校验工具级静态配置。 */
export function parseInterrupt(value: unknown, InvalidError: InterruptErrorCtor): InterruptParam | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === true) {
    return true;
  }
  if (!isRecord(value)) {
    throw new InvalidError(value, "interrupt 必须是 true 或对象");
  }
  const rawOn = value["interruptOn"];
  if (!isRecord(rawOn)) {
    throw new InvalidError(value, "interrupt.interruptOn 必须是对象");
  }
  const interruptOn: Record<string, InterruptEntry> = {};
  for (const [toolName, raw] of Object.entries(rawOn)) {
    if (!isRecord(raw)) {
      throw new InvalidError(value, `interrupt.interruptOn.${toolName} 必须是对象`);
    }
    if (raw["when"] !== undefined) {
      throw new InvalidError(value, `interrupt.interruptOn.${toolName}.when 不支持（v0.2.1 仅静态配置，when 由代码注入）`);
    }
    const description = raw["description"];
    if (description !== undefined && typeof description !== "string") {
      throw new InvalidError(value, `interrupt.interruptOn.${toolName}.description 必须是字符串`);
    }
    const allowedRaw = raw["allowedDecisions"];
    const decisions: ("approve" | "reject")[] = [];
    if (allowedRaw !== undefined) {
      if (!Array.isArray(allowedRaw)) {
        throw new InvalidError(value, `interrupt.interruptOn.${toolName}.allowedDecisions 必须是数组`);
      }
      for (const [index, decision] of allowedRaw.entries()) {
        if (decision !== "approve" && decision !== "reject") {
          throw new InvalidError(value, `interrupt.interruptOn.${toolName}.allowedDecisions[${index}] 非法: "${String(decision)}"（v0.2.1 仅支持 approve/reject）`);
        }
        decisions.push(decision);
      }
    }
    interruptOn[toolName] = {
      ...(description !== undefined ? { description } : {}),
      ...(allowedRaw !== undefined ? { allowedDecisions: decisions } : {}),
    };
  }
  return { interruptOn };
}

/** interrupt:true 展开：覆盖全部注入工具，allowedDecisions 缺省 approve/reject。 */
export function allToolsInterrupt(tools: readonly HNFlowTool[]): AIInterruptConfig {
  const interruptOn: Record<string, InterruptEntry> = {};
  for (const tool of tools) {
    interruptOn[tool.name] = { allowedDecisions: ["approve", "reject"] };
  }
  return { interruptOn };
}
