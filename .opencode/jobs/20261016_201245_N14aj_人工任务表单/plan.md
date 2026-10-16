# N14-切片AJ 通用 human:task / approval 提交表单 —— 执行计划

> 来源：N14ae 的诚实取舍遗留项（「泛型 human:task/approval 端口任意，本卡不处理」），
> 也是 N10 审批门的画布侧缺口：挂起时画布无法批准/提交。
> 状态：**已完成**（纯前端切片，后端零改动）。

## 范围

- `core/workflows/human-tasks.ts`：通用任务模型（outputSpec / validationRules / preview 归约）
  + `humanTaskFields` 字段推导 + `serializeHumanTaskDrafts` 全有或全无序列化
  + `pendingHumanTasks` 选择器。
- 新增 `components/.../workflow-human-task-form.tsx`：逐字段控件 + 审批预览 + 提交/跳过。
- 运行面板：按 `pendingHumanTasks` 渲染这些表单。

## 关键设计

- **字段只来自行自带声明**（`output_spec` + `validation_rules`）：多一个字段永远提交不了，
  少一个等于绕过门。
- **bool 未选则留空**：未触碰的审批绝不能让 `false`（= 拒绝不可逆操作）悄悄提交。
- **端口类型优先于 enum 规则**：审批的 `decision` 是 bool 端口，`enum: [true,false]` 是**约束取值**；
  若按下拉渲染会提交字符串 `"true"`（后端要布尔）。bool 选项取规则允许的布尔值
  （断点 `acknowledge: [true]` 因此只给一个 true 按钮）。
- 本地错误先于请求；后端 422 逐字回显。

## 验收

- 前端 1230→1261 passed；`check` exit 0；`format` 全绿。
- 新增 29 条测试（node +18 / 表单 DOM 9 / 面板 +2）。
