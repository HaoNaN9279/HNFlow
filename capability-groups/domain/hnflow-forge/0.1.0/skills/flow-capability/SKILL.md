---
name: flow-capability
description: 当流程需要可复用的领域知识、操作手法或人设，需要配套生成 HNFlow 能力组时使用：目录结构、group.json、四类内容分工、节点 instruction 的引用写法、激活步骤与依赖声明。
---

# 配套能力组（Capability）

流程只写契约与顺序；“怎么做”放能力组。**先查有没有现成的组，再考虑新建。**

## 何时建

满足任一条才建：知识在两条以上流程复用；手法会反复用到；需要域特定规则约束子 Agent 行为。
只是本次的一次性说明 → 写进节点 `instruction` 或项目文件，不建组。

## 目录

```text
capability-groups/domain/<name>/<version>/
├── group.json
├── rules/<name>.md            # 常驻：越短越好
├── agents/<name>.md           # 人设 / 子代理
├── commands/<name>.md         # 人手动触发
├── skills/<skill-name>/SKILL.md
└── references/<doc>.md        # 不在解析范围，供技能按需读
```

工具代码**不放组内**：放 `tools/<name>/<version>/`，由 `group.json` 的 `tools` 用 `tool:<guid>@v<version>` 引用。

## group.json 最小可用

```json
{
  "guid": "<32 位小写十六进制，全仓唯一>",
  "name": "<组名，等于目录名>",
  "version": "0.1.0",
  "description": "一句话",
  "permissions": ["fs"],
  "extends": [],
  "tools": []
}
```

新 guid：`python -c "import uuid; print(uuid.uuid4().hex)"`。已发布版本目录不可改，升级新建版本目录、guid 不变。

## 四类内容怎么分

| 内容 | 放哪 | 判据 |
| --- | --- | --- |
| 必须始终遵守的约束（风格、禁改区域、安全） | `rules/` | 违反即错，且每次都要生效 |
| 可复用的操作流程/手法（含步骤、命令、示例） | `skills/` | 需要时加载，写全步骤 |
| 会话人设（谁在说话、职责边界） | `agents/` | 只影响系统提示，不限制工具 |
| 人主动触发的批量动作 | `commands/` | 有明确输入参数与输出报告 |
| 参考资料（格式速查、案例库） | `references/` | 体积大、按需读 |

规则与技能都要写 frontmatter：规则 `name`；技能 `name` + `description`（1–1024 字符，写“当…时使用”）；Agent `name`/`description`/`mode`；命令 `name`/`description`。

## 节点 instruction 怎么引用

好：

```text
按 hnflow-forge 的 flow-author 技能写作规范完成本节；本次要求：<参数>。
输出契约见 output，不要输出额外字段。
```

坏（把技能正文抄进 instruction）：

```text
先读 A，再读 B，然后按 1/2/3 步……（几百字步骤）
```

坏（让子 Agent 自己找）：

```text
按项目规范处理。
```

要点：**技能名 + 本次参数 + 输出契约**，三件；不复制正文，不写绝对路径。

## preset 与模型层

| 概念 | 来源 | 能力组能做什么 |
| --- | --- | --- |
| 节点 `preset` | DSH 已注册的 preset（默认 allowlist `hnflow`、`standard`） | 只能选，不能新增；写错报 `preset-not-allowed` |
| Agent 人设 | 能力组 `agents/*.md` | 影响会话系统提示，**不是** preset |
| 节点 `model` | HNFlow 平台模型层 id（`fast` / `standard` / `strong` / `vision`） | 只写层 id；可省略（继承当前路由）；层未在本机绑定则失败，不回落 |
| 能力组 Agent / 命令 / 技能的 `model` | 同上 | 只写层 id；自定义层仅 DSH 可用，不能写进共享能力组 |

所以：能力组给流程提供的是**知识与手法**，不是执行单元；流程节点的执行者仍是 preset 决定。
层目录由 HNFlow 平台统一提供；能力组不得写 provider、具体模型名、温度或权限。

## 激活与依赖

```bash
hnflow-stack activate <name>@<version>   # 只改项目 .hnflow/stack.json
hnflow-stack sync                        # 严格校验并写 lock.json
hnflow-stack status                      # 核对当前激活项
```

流程依赖能力组时：

- 写进 `flow.description`：`requires:<group>`，并在交付报告里重复一次。
- 插件**不会**校验该依赖（`preset` 只能取宿主 allowlist，流程定义没有依赖字段）；缺组时节点仍能跑，只是少了领域知识。
- 因此：交付时明确告知“本流程假设工作区已激活 `<group>`”。

## 优先复用

- 已存在的能力组能覆盖 → 直接引用，别新建同职责的组。
- 需要能力组制作细则（规则/技能/Agent/命令/工具的字段与校验）→ 加载 `capability-group-forge-custom-*` 技能（本组 `extends: group-forge`，已随激活加载）。
- 组内容跨组同名会互相覆盖（后加载者赢），命名加领域前缀。

## 自检

`hnflow-stack resolve --json --project <项目>` 无告警；技能目录名 = `name`；组内无 `tools/`、`pyproject.toml`、工具源码；规则文件足够短。
