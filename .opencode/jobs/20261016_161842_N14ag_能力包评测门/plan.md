# N14-切片AG §24.8 能力包导入评测门 —— 执行计划

> 来源：《HNFlow 开发方案.md》§24.8「评测/回归 · CI：把 eval 挂到能力包导入/升级与工作流保存」。
> 状态：**已完成**（§24.8 收官）。

## 范围

- `skills/eval_gate.py`：收集包自带 `evals/*.json` 的 trigger 用例 + 注入式判定 + 门禁策略。
- `skills/eval_judge.py`：模型触发判定（只在该包 `require_pass` 时构造）。
- 两条安装路径接线（安全扫描之后、提交之前）。

## 关键设计与取舍

- **只判定 trigger 用例**：行为类期望（assertions / expected_readiness）需要自己的 runner，
  本门只计数不判定（无法验证却报「通过」= 撒谎）。
- **opt-in 属于包作者**：dict manifest 的 `require_pass: true` 才门禁；裸清单无处声明 → 只报告。
  故**默认安装路径零模型调用**。
- **声明的门跑不起来 → 拒绝安装**（无 judge、或某用例无法判定）；坏 manifest → 仅告警（与
  review 包 `eval.invalid-json` = warning 的既有口径一致）。
- **单一词汇来源**：抽出 `review/eval_schema.py::iter_manifest_cases`，review 统计与安装门共读。

## 验收

- 新增 32 条测试全过；全量 A/B 11403→11435 passed，**失败集合与基线逐条一致（75 = 75）**。
- ruff clean；无迁移/无新表/无新配置段/无新依赖；前端零改动。
