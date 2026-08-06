// 模板库种子模板（首次启动写入 userData/templates 的内容）。
// 同步自 tests/fixtures/templates/demo-template，修改需两处同步。
// 结构 = template.json 元数据 + versionsWorkflows（版本号 → workflow.json 内容对象），写盘时展开为目录布局。

/** 单个种子模板：template.json 元数据 + 各版本 workflow 内容（版本号 → workflow.json 对象）。 */
export interface SeedTemplate {
  readonly name: string;
  readonly description: string;
  readonly versions: readonly { readonly version: string; readonly createdAt: string; readonly changelog: string }[];
  readonly currentVersion: string;
  readonly interface: { readonly inputs: readonly string[]; readonly outputs: readonly string[] };
  readonly versionsWorkflows: Readonly<Record<string, unknown>>;
}

/** 种子模板集（当前仅演示模板；v1.0.0 与 v1.1.0 端口差异用于升级演示）。 */
export const SEED_TEMPLATES: readonly SeedTemplate[] = [
  {
    name: "demo-template",
    description: "演示模板：展示版本升级端口映射",
    versions: [
      { version: "1.0.0", createdAt: "2026-01-15T08:00:00.000Z", changelog: "初始版本" },
      { version: "1.1.0", createdAt: "2026-06-20T08:00:00.000Z", changelog: "新增 author 输入与 report 输出" },
    ],
    currentVersion: "1.1.0",
    interface: { inputs: ["title", "content", "author"], outputs: ["result", "report"] },
    versionsWorkflows: {
      "1.0.0": {
        id: "demo-template-workflow",
        name: "演示模板",
        version: "1.0.0",
        nodes: [
          {
            id: "start",
            type: "start",
            name: "开始",
            params: {},
            inputs: [],
            outputs: [{ id: "data", name: "data", type: "any", direction: "out", binding: "workflow:start" }],
            position: { x: 0, y: 0 },
          },
          {
            id: "text-build",
            type: "setVariable",
            name: "文本构建",
            params: { target: "workflow:result", value: "${workflow:params:title}：${workflow:params:content}" },
            inputs: [
              { id: "in_title", name: "title", type: "any", direction: "in", binding: "workflow:params:title" },
              { id: "in_content", name: "content", type: "any", direction: "in", binding: "workflow:params:content" },
            ],
            outputs: [{ id: "out_result", name: "result", type: "any", direction: "out" }],
            position: { x: 200, y: 0 },
          },
          {
            id: "end",
            type: "end",
            name: "结束",
            params: {},
            inputs: [{ id: "in", name: "data", type: "any", direction: "in", binding: "workflow:endInput" }],
            outputs: [],
            position: { x: 400, y: 0 },
          },
        ],
        edges: [
          { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "text-build", targetPortId: "in_title" },
          { id: "e2", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "text-build", targetPortId: "in_content" },
          { id: "e3", sourceNodeId: "text-build", sourcePortId: "out_result", targetNodeId: "end", targetPortId: "in" },
        ],
      },
      "1.1.0": {
        id: "demo-template-workflow",
        name: "演示模板",
        version: "1.1.0",
        nodes: [
          {
            id: "start",
            type: "start",
            name: "开始",
            params: {},
            inputs: [],
            outputs: [{ id: "data", name: "data", type: "any", direction: "out", binding: "workflow:start" }],
            position: { x: 0, y: 0 },
          },
          {
            id: "text-build",
            type: "setVariable",
            name: "文本构建",
            params: {
              target: "workflow:result",
              value: "${workflow:params:title}：${workflow:params:content}（作者：${workflow:params:author}）",
            },
            inputs: [
              { id: "in_title", name: "title", type: "any", direction: "in", binding: "workflow:params:title" },
              { id: "in_content", name: "content", type: "any", direction: "in", binding: "workflow:params:content" },
              { id: "in_author", name: "author", type: "any", direction: "in", binding: "workflow:params:author" },
            ],
            outputs: [{ id: "out_result", name: "result", type: "any", direction: "out" }],
            position: { x: 200, y: 0 },
          },
          {
            id: "report-build",
            type: "setVariable",
            name: "报告构建",
            params: { target: "workflow:report", value: "报告：${workflow:params:title}（${workflow:params:author}）" },
            inputs: [{ id: "in_text", name: "text", type: "any", direction: "in" }],
            outputs: [{ id: "out_report", name: "report", type: "any", direction: "out" }],
            position: { x: 400, y: 0 },
          },
          {
            id: "end",
            type: "end",
            name: "结束",
            params: {},
            inputs: [{ id: "in", name: "data", type: "any", direction: "in", binding: "workflow:endInput" }],
            outputs: [],
            position: { x: 600, y: 0 },
          },
        ],
        edges: [
          { id: "e1", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "text-build", targetPortId: "in_title" },
          { id: "e2", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "text-build", targetPortId: "in_content" },
          { id: "e3", sourceNodeId: "start", sourcePortId: "data", targetNodeId: "text-build", targetPortId: "in_author" },
          { id: "e4", sourceNodeId: "text-build", sourcePortId: "out_result", targetNodeId: "report-build", targetPortId: "in_text" },
          { id: "e5", sourceNodeId: "report-build", sourcePortId: "out_report", targetNodeId: "end", targetPortId: "in" },
        ],
      },
    },
  },
];
