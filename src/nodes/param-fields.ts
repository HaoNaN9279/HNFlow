// 参数 schema 独立定义：字段较多且节点文件已接近 250 行上限时抽离至此。
// 编辑器可视化参数面板据此渲染表单；字段 key/default/required 与各节点 parseParams 一致。
import type { ParamField } from "../execution/types.js";

/** ai 节点参数 schema（字段与 ai.ts parseParams 读取的键一一对应）。 */
export const aiParamsSchema: readonly ParamField[] = [
  {
    key: "inputMessages",
    label: "输入提示词",
    type: "textarea",
    description: "字符串=单条 user 消息；数组=[{ role, content }]",
  },
  { key: "systemPrompt", label: "系统提示词", type: "textarea" },
  {
    key: "model",
    label: "模型配置",
    type: "json",
    default: { provider: "openai" },
    description: '{ provider: "openai" | "fake", model?, apiKey?, baseURL?, fakeScript? }',
  },
  {
    key: "tools",
    label: "工具引用",
    type: "json",
    description: '字符串数组，如 ["web_search"]',
  },
  { key: "stream", label: "流式输出", type: "boolean", default: false },
  {
    key: "interrupt",
    label: "工具审批中断",
    type: "json",
    description: 'true 或 { interruptOn: { 工具名: { description?, allowedDecisions? } } }',
  },
];
