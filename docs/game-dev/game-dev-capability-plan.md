# 游戏开发能力组：`game-dev` 0.1.0

> 状态：已实现。组目录：`capability-groups/domain/game-dev/0.1.0/`。
> 依赖：3D 子层通过 `extends: ["image-gen"]` 使用图像生成组；图像生成走免费 Pollinations 端点。

## 1. 定位

`game-dev` 是游戏开发能力组：负责玩法与内容规划、资产规格、生成策略和验收标准；具体引擎与运行时留给引擎层或项目内容。

组内分三层：

| 层级 | 路径 | 职责 |
|---|---|---|
| 根层 | `game-dev` | 通用内容：开发简报、资产 brief、资产契约与验收 |
| 3D 层 | `game-dev/3d-model-gen` | three.ws 免费 3D 生成、绑定、精修、GLB 交接 |
| 引擎层 | `game-dev/unity` | Unity 工程约定、C# 代码规范、引擎 bug 规避；通过 `unityMCP` 操作引擎 |

根层不引用子层：`3d-model-gen`、three.ws、`image-gen`、Pollinations 只出现在 3D 层内容里；`unity`、`unityMCP`、C# 约定只出现在引擎层内容里。子层自动继承根层，根层不需要知道它们存在。

3D 层通过 `extends` 依赖 `image-gen`。需要独立概念图/参考图时，用图像生成组的 `text-to-image`；不需要图像时，免费 3D 流程本身即可完成文字→GLB。

## 2. 目录

```text
capability-groups/domain/game-dev/0.1.0/
  group.json
  rules/
    00-game-dev.md              # 开发上下文、资产契约、生成与交付、验收
  skills/
    game-dev-brief/             # 想法 → vertical slice 简报 + 资产清单
    game-asset-brief/           # 单资产 → 可生成的 3D brief
  levels/3d-model-gen/
    group.json                  # name 3d-model-gen，extends image-gen
    rules/
      00-3d-generation.md       # 免费优先、限流、幂等、校验、元数据
    skills/
      free-3d-generation/       # MCP 调用、轮询、下载、catalog
      3d-asset-handoff/         # GLB 校验、预览、元数据、导入验收
    references/
      three-ws-free-3d.md       # 免费 3D 接口与工具 schema
  levels/unity/
    group.json                  # name unity，tools: unityMCP
    rules/
      unity.md                  # 工程结构与开发约定、MCP 优先、2022.3 文档
      unity-code-standards.md   # 命名、目录、生命周期、注释规范
      unity-bugs.md             # 已知引擎 bug 索引
      bugs/UnityMonoEnum泛型NativeCrash.md  # on_demand，Mono 泛型枚举崩溃记录
```

## 3. 能力边界

装：

- 玩法/关卡/垂直切片简报。
- 资产清单与单资产 brief：尺度、朝向、枢轴、面数、材质、绑定/动画、碰撞。
- 免费 3D 生成的选择矩阵、调用、轮询、下载与校验。
- GLB 预览、元数据、来源记录与导入验收。
- 通过依赖组生成概念图/参考图（免费 Pollinations 端点）。

不装：

- 引擎 API、具体导入设置、C#/C++/GDScript 业务代码留在引擎层或项目内容，根层不写。
- 根层里的子层引用：子层名称、three.ws、`image-gen`、Pollinations、`unityMCP` 与调用参数只在对应子层出现。
- 超出免费额度的高精度/商业 SLA 方案。
- 图像生成接口本身（属于 `image-gen`）。
- HNFlow 流程定义；本版本只提供技能与规则。

## 4. 使用顺序

1. `game-dev-brief`：把游戏想法收敛成 vertical slice，列出 P0/P1/P2 资产。
2. `game-asset-brief`：把单个资产写成 brief（含 prompt、尺度、绑定需求）。
3. 需要参考图：用 `image-gen/text-to-image` 生成（免费端点）。
4. `free-3d-generation`：调用 three.ws 免费 MCP，轮询并下载 GLB。
5. `3d-asset-handoff`：校验、预览、写元数据、按导入清单验收。

## 5. 激活与校验

```sh
# 只启用根层（纯规划，不生成 3D）
hnflow-stack activate game-dev@0.1.0

# 启用 3D 层，根层与 image-gen 依赖隐式加载
hnflow-stack activate game-dev/3d-model-gen@0.1.0

# 启用 Unity 引擎层，根层隐式加载，并带上 unityMCP 工具
hnflow-stack activate game-dev/unity@0.1.0

hnflow-stack validate
hnflow-stack resolve --json --project <项目>
```

子层激活只把该子层写进项目 `.hnflow/stack.json`（如 `game-dev/unity`）；`game-dev` 作为祖先、`image-gen` 作为 extends 依赖，由解析器隐式加载。子层的 `version` 必须等于根版本 `0.1.0`。

## 6. 免费边界

本组只走 three.ws 的免费 3D MCP、免费 REST 检查端点，以及 `image-gen` 的免费 Pollinations 图像端点；不记录也不调用需要付款、余额或订阅的入口。Unity 层使用本地 `unityMCP`（`http://127.0.0.1:8080/mcp`），不涉及付费额度。

| 能力 | 免费入口 |
|---|---|
| 文生 3D draft | REST `/api/v1/ai/text-to-3d`、`/api/3d/generate` |
| 文生 3D standard/high | MCP `forge_free`（平台出资） |
| 绑定 | MCP `rig_mesh` / `forge_avatar` |
| 精修 | MCP `refine_model` |
| 现成资产 | catalog（CC0） |
| 概念图/参考图 | `image-gen` 的 `text-to-image`（Pollinations 匿名端点） |

## 7. 后续

- 引擎层已落地 `game-dev/unity`；Unreal/Godot 后续按同样方式作为单独子层加入，不塞进根层。
- 需要门禁/人工确认的资产流水线时，再另立 HNFlow 流程。
