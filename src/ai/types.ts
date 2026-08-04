// HNFlow AI 工具类型：代码级工具注册契约，executor 注入 LangGraph Agent。
import type { z } from "zod";

/** HNFlow 工具定义：代码级注册，executor 注入。 */
export interface HNFlowTool {
  /** 完整工具名（含命名空间前缀，如 "demo.getWeather"）。 */
  readonly name: string;
  /** 工具说明：供模型理解用途与触发条件。 */
  readonly description: string;
  /** 参数 JSON schema（zod object），转 langchain tool 用。 */
  readonly parameters: z.ZodObject<z.ZodRawShape>;
  /** 实际执行函数：输入参数 → 返回结果（字符串或对象）。 */
  readonly handler: (input: Record<string, unknown>) => unknown | Promise<unknown>;
}
