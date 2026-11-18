# Unity 框架能力组：`game-dev/unity/framework` 规划

> 状态：规划中，尚未创建任何组目录。
> 目标对象：HNUnityFramework（`com.hn.framework` 1.0.0，Unity 2022.3+，MIT）。
> 归属：`game-dev` → `unity` → `framework` 及其子层，版本统一 `0.1.0`。
> 本文只描述能力组装什么知识，不复制框架源码，不改框架仓库。

## 1. 目标

让 Agent 在**不读框架源码**的前提下，能正确完成三件事：

1. 把框架接进 Unity 工程并跑起来；
2. 用框架已有能力写业务（数据、玩法、界面、动画、网络）；
3. 在能力缺失或半实现时给出可用替代，而不是编造 API。

每组只承载四类内容：

| 类型 | 写什么 | 不写什么 |
|---|---|---|
| `rules` | 使用顺序、生命周期、约束、已知坑、实现状态 | 内部算法、类设计理由 |
| `skills` | 可执行的操作流程与产物 | 框架源码片段 |
| `references` | API 索引、菜单索引、错误与差异清单 | 逐行源码解读 |
| `flows` | 暂不建（见 §10） | — |

## 2. 结构原则

### 2.1 父层是子层的前置，子层只写增量

层不是目录分类，是依赖顺序：**激活一个子层，就自动拿到它全部祖先的知识**。因此每条父子边必须对应真实的使用依赖——子层的任务离开了父层内容就做不成。解析器只保证加载顺序，不校验内容依赖，所以边写错不会被报错，只会在使用时露出缺口。

### 2.2 同级层之间功能独立，互不引用

兄弟层各自只依赖共同祖先，正文不得出现兄弟层的名称、路径、专属类型或工具。落地检查两条：

- 删除任意一个子层，其余层内容仍可独立使用；
- 兄弟层规则全文 grep 不到对方的层名与专属类型。

需要两个兄弟层的能力才能完成的任务，说明层级放错了，应当下移公共知识或合并。

### 2.3 编辑器工具跟随领域，不单独成层

编辑器工具与领域强绑定：配置表编辑器离不开配置表，动画窗口离不开动画数据。单独的 `editor` 层会同时依赖玩法、资源、动画三个分支，必然变成"什么都依赖"的兄弟层。处理方式：

| 工具 | 归属 |
|---|---|
| EditorUI 属性、HNSmartInspector、Deploy、构建管线、HybridCLR 构建 | `framework` |
| 资源质检、冗余清理、Addressables 扩展、配置表编辑器 | `assets` |
| Graph 编辑器 | `gameplay` |
| 输入调试、UI 相关工具 | `presentation` |
| 动画调试、IK/重定向/表情/压缩分析窗口、Timeline 批注 | `animation` |

### 2.4 深度与注入成本

层级越深，激活时注入的祖先规则越多。限制：路径不超过 7 段（解析器上限 8），每层规则不超过 4 个，深层不重复祖先内容。

### 2.5 常驻与按需

每条规则标注注入方式：

| 标注 | frontmatter | 效果 |
|---|---|---|
| `常驻` | 不写 `on_demand`（默认 `false`） | 正文进入每个会话 |
| `按需` | `on_demand: true` | 只注入 `- <路径>: <description>` 摘要行，Agent 需要时读全文 |

判据：

- **常驻**：约束在几乎每次任务都成立，且篇幅可控——生命周期、命名、加载/释放纪律、层内主流程。
- **按需**：只在特定任务出现时才需要——构建、物理、配置表、战斗数值、过场、视图接线、Playable 限制、热更；或本身是长清单、速查表、故障记录。
- 按需规则的 `description` 必须写清「什么时候要读」，它是 Agent 判断是否读取的唯一依据。
- 每层常驻规则控制在 2 个以内；超过说明主题该合并，或该下移到更浅的层。

## 3. 目录结构与依赖

```text
game-dev/unity                          # 已有：Unity 引擎口径、C# 规范、unityMCP
└── framework                           # 工程接入、启动骨架、规范、模块地图、构建发布
    └── runtime                         # 驱动骨架、基础类库、池、流程、MVC、事件、序列化、物理
        ├── assets                      # 资源、配置表、本地化、存储、资源类编辑器
        │   └── gameplay                # Tag、HFSM、Entity、图、战斗、任务、背包、AI
        │       ├── presentation        # UI、输入、相机、过场
        │       └── animation           # 动画逻辑、表现接入、动画编辑窗口
        └── network                     # 网络、帧同步、预测回滚、热更
```

| 边 | 前置依据 | 类型 |
|---|---|---|
| `framework → runtime` | 没有 GameEntry、程序集与设置资产，运行时模块无处挂载 | 使用前置 |
| `runtime → assets` | `AssetManager` 是 `ITickable`，缓存项走 `ReferencePool`，过期回收靠 `World.Tick` | 代码引用 |
| `runtime → network` | 帧同步推进 `HNLogicTime`，网络消息走框架序列化；两者都不需要资源层 | 代码引用 |
| `assets → gameplay` | 战斗/任务/背包的数值与奖励以 Sheet 表为数据源，实体配置 ID 指向表与 Addressables 资源；Combat/Quest 代码不 `using Sheet`，属数据入口前置 | 使用前置 |
| `gameplay → presentation` | `EntityView` 携带 `EntityId`/`EntityDefId`，`PropertyBinder`/`DefaultPropertyBinder` 引用 `Level.Logic` | 代码引用 |
| `gameplay → animation` | `Animation/ControlRig/ControlRig.cs` 引用 `Graph`；动画请求由玩法状态驱动 | 代码引用 + 使用前置 |

```text
已验证的代码引用：
Logic/Inventory/Equipment/Equipment.cs        → Logic/Combat
Logic/Inventory/Item/ItemBuffSpec.cs          → Logic/Combat
Logic/Animation/ControlRig/ControlRig.cs      → Logic/Graph
View/Binding/PropertyBinder.cs                → Logic（Entity/Model 语义）
View/UI/UIManager.cs                          → Addressables（预加载、回退 Resources）
```

`presentation` 与 `animation` 互为兄弟：UI 不需要动画数据，动画不需要 UI；二者的共同前置只有 `gameplay`。`assets` 与 `network` 互为兄弟：加载资源不需要联网，联网不需要配置表。这是本方案唯一两处兄弟关系，均通过"删除一层不影响另一层"检查。

## 4. 逐层内容

各层目录位于 `capability-groups/domain/game-dev/0.1.0/unity/` 下：`framework/`、`framework/runtime/`、`framework/runtime/assets/`、`framework/runtime/assets/gameplay/{presentation,animation}/`、`framework/runtime/network/`。下文只写层内相对路径；`# 常驻` / `# 按需` 对应 §2.5 的注入方式。

### 4.1 `framework`

```text
group.json
  rules/entry.md            # 常驻 · 接入、程序集边界、启动顺序、模块状态表、禁止项
  rules/conventions.md      # 常驻 · 命名空间/命名/注释/测试；与 unity 层通用规范的分工
  rules/build.md            # 按需 · Deploy、构建管线四步、版本来源、HybridCLR 构建
  skills/framework-onboarding/ # 空工程 → 可运行的 GameEntry
  skills/module-check/         # 任务前核对模块状态，半实现模块给替代路线
  references/api-index.md      # 入口类型与设置资产索引（含框架仓库相对路径）
  references/known-gaps.md     # 未实现/半实现/文档与代码不一致清单
```

要点：

- 入口链：`GameEntry : GameWorldDriver` → `Awake` 自动 `new GameWorld` 并注入 Log/Asset/Input/UI/Locale/Physics/FrameSync → 重写 `OnRegisterGameModules` → `World.Initialize()`；`Update`→`Tick`、`LateUpdate`→`LateTick`。禁止自建 `GameWorld`，禁止在 `Awake` 之前访问 `World`。
- 逻辑帧只由 `LockstepManager`（默认 15 Hz）推进，`HNLogicTime` 只读；GlobalSettings 的 LogicRate / MaxStepsPerFrame / MaxFrameTime 无运行时读取。
- 程序集：`HN.Framework.Core`（`noEngineReferences`，禁 UnityEngine）← `HN.Framework.Unity` ← `HN.Framework.Editor`；项目 asmdef 只引用前两者，不改框架 asmdef。
- 必装依赖：Addressables、Cinemachine、Input System、Timeline、TMP、Newtonsoft；**HybridCLR 必须预装**，否则 Editor 程序集编译失败。
- 目录约定：`Assets/Project/{RuntimeAssets,EditorAssets,Scripts}`、`AddressableAssetsData`、`StreamingAssets`。
- 构建：Deploy 一次生成目录、8 个设置资产、GameEntry 场景与 Addressables 组预设（会 `NewScene(Single)` 顶掉当前场景）；管线 = PreBuildValidation（Error 且勾 BlockBuild 即中止）→ Addressables → Player → PostBuild（只清理）；VersionConfig 路径无人创建，首次打开构建窗口失败、版本号为空；Build Reports 窗口永远空。
- 状态表：完整 = 流程/池/事件/调试/本地化/UI/输入/相机（有 Brain）/过场（自建）/物理（手动 Step）/HFSM/Tag/图/配置表/动画核心；部分 = Asset/Storage/Scripting/MVC/Entity/战斗/任务/背包/构建管线；未实现 = 音频运行时、SceneStreaming、TimeWeather、Security、Performance。

### 4.2 `runtime`

```text
rules/procedure-mvc.md   # 常驻 · 流程状态与 MVC 的生命周期、事件式钩子、实例池化
rules/pooling.md         # 常驻 · ObjectPool / GameObjectPool / ReferencePool 选择与释放纪律
rules/libraries.md       # 按需 · 事件、日志、调试、JSON/MemoryPack、逻辑时间、随机、字典
rules/physics.md         # 按需 · IPhysicsWorld 注入与手动 Step、Body 生命周期、坐标类型转换
skills/add-procedure-state/ # 新增流程状态并挂进 GameEntry
skills/pool-object/         # 为对象选池型、写 Settings、验证释放
references/runtime-api.md   # 各入口签名与错误行为
```

要点：`ProcedureState` 的 Enter/Tick/LateTick/Exit 是 **event 不是虚方法**；状态实例由 ReferencePool 造，禁止 `new`；`ChangeState` 重入被忽略。MVC 的 Model 不被 Tick，Unit 的五个方法必须全部实现。`ReferencePool` 是进程级静态，切场景/重开局必须 `ClearAll()`。`EventBus` 同步派发、异常吞、无弱引用，订阅必须成对退订。`Json` 只序列化 public 实例字段，不支持属性，枚举存 int。`StorageProvider` 只有接口。物理：`IPhysicsWorld` 由 Driver 以 D3 注入，`Step` 是空实现需自行驱动，与 `autoSimulate` 同开会双模拟；`PhysicsVector3` 没有 `Vector3` 隐式转换。物理放在 `runtime` 而不是 `presentation`：`IPhysicsWorld` 是 `GameWorld` 属性、全仓引用者只有 `GameWorld`，玩法与表现都可能用到它。

### 4.3 `assets`

```text
rules/assets.md          # 常驻 · Addressables 正路、AssetManager 现状与引用计数、Label 约定
rules/data.md            # 按需 · Sheet 三行表头、AssetRef 解析、本地化 key 与 JSON 结构
skills/load-release-asset/  # 按 Addressables 加载/释放，写清计数与释放时机
skills/sheet-authoring/     # 新建/修改 xlsx 并导入
skills/localize-text/       # 新增文案，接 TextLocalizer / AssetLocalizer
references/asset-and-locale.md
```

要点：`IAssetManager` 的加载方法全部返回 `void`，没有取回资源的 API；`LoadAsset` 走 `IAssetOperator.LoadAsset` 同步分支，而 `AddressablesOperator` 只实现异步，打包后该调用必定报错并返回 null（编辑器下 `AssetDatabaseOperator` 可用）。资源加载以 Addressables API 为准。`LoadSceneGroup` 依赖 `LoadRecord.SceneLabels`，全仓只有初始化与过滤、无写入点，命中 0 条静默返回。Sheet 拖入的 `AssetRef` 写资源路径，运行时按 Addressables Label 解析，必须手改。本地化表 key 为 `{baseKey}_{Code}`，`LocaleManager.SetLocale` 是 `async void`。

### 4.4 `gameplay`

```text
rules/tags-fsm.md        # 常驻 · Tag 加载/Freeze/查询、HFSM 手动 Update 与 isAllowedTrans
rules/entity-graph.md    # 常驻 · Entity 不建视图、Graph 无执行器
rules/combat.md          # 按需 · 属性初始化、按 set Tick、伤害管线、Buff 不回滚、标签门禁缺失
rules/quest-inventory.md # 按需 · 单次 Initialize、Claim 幂等、堆叠上限、装备 Buff 未实现
skills/combat-ability/      # 新增技能/ Buff 并接管线
skills/quest-flow/          # 接任务到领奖的完整链路
skills/inventory-item/      # 新增物品、容器、装备
references/gameplay-api.md
```

要点：`GameplayTagManager` 必须先 `Load` 再 `Freeze`，否则层级匹配恒 false，全仓没有 `Freeze` 调用点。HFSM 必须自己每帧 `Update`，状态在 `OnCreate` 未置 `isAllowedTrans=true` 时出边不评估。`EntityManager` 不创建视图，`CreateView` 传入的 `entityId` 为 0。`GraphData.AddEdge` 不校验端点，也没有执行器。Combat 的 `AttributeSet` 需先 `Freeze`，`Tick(dt, set)` 按 set 推进；移除 Buff 不回滚属性；Ability 无标签门禁。Quest 的 `Initialize` 只能调一次，`Claim` 先发奖后校验，重复 Claim 重复发奖，`RewardProcessor` 恒返回 Success。Inventory 堆叠不读 `MaxStack`，装备 Buff 是 TODO。依赖只有 Inventory→Combat，Quest/Entity 仅经 EventBus。

### 4.5 `presentation`

```text
rules/ui.md               # 常驻 · UIManager 七层、面板/弹窗/Toast/引导生命周期
rules/input-camera.md     # 常驻 · 空 InputActionAsset 的替换、Blocker 语义、CinemachineBrain 前置
rules/cutscene.md         # 按需 · 过场必须自建并注入、优先级与跳过、演员绑定
rules/entity-view.md      # 按需 · EntityView/ViewFactory/PropertyBinder 的现状与接线缺口
skills/new-ui-panel/         # 新建 UIPanel 并注册到对应层
skills/cutscene-play/        # 写一段过场、注册演员、播放与跳过
references/presentation-api.md
```

要点：`UIManager` 在 Driver 里已初始化，七层 Canvas 自动创建；`PushAsync` 同一面板重复调用会堆积实例，关闭只是 `SetActive(false)`。`InputManager` 被注入的是空资产，必须先替换，否则 `RegisterAction` 抛"动作不存在"；任意 Blocker 屏蔽全部输入。`CameraManager` 仅当场景有 `CinemachineBrain` 时被注入。`CutsceneManager` 不会自动创建，必须项目 `new` 后赋给 `world.CutsceneManager`。`ViewFactory`/`PropertyBinder` 与 `Entity` 未接线：`EntityManager` 不建视图，`PropertyBinder` 只有抽象，`DefaultPropertyBinder` 才可用。音频只有 `AudioSettings` 资产。物理见 `runtime` 层。

### 4.6 `animation`

```text
rules/animation-logic.md  # 常驻 · 建表、哈希一致性、请求优先级、快照只读、LOD 暂停
rules/animation-view.md   # 常驻 · 表现层只消费 Layers/Montages，Additive/Events/MotionIntent 需自接
rules/playable-limits.md  # 按需 · Playable 已知限制与规避
skills/animate-character/    # 从建状态机到在角色上跑起来
skills/animation-knowhow/    # 蒙太奇/同步组/IK/压缩等按需查阅（on_demand）
references/animation-api.md
```

要点：`AnimationStateDef.Hash` 必须自己算且与名称/片段一致；请求优先级低于当前状态且非 Restart 会被丢弃，同帧只应用最高优先一条；快照里的列表是复用实例，只有 `Version` 变化才可重建。池上限 Additive 4 层、Montage 2 个。逻辑层 LOD 会暂停远处角色的 Tick。Playable 侧禁 `Pause()`（用 `SetSpeed(0)`）、脚本 Playable 只留 1 个输入端口、权重夹在 [0.0001,1]。表现层两个 Representation 只消费 Layers+Montages，其余需自行接线；`InertializationBlender` 无人引用。Skeleton2D 只取 X 位移、无 DragonBones 导入；面部无运行时表现。

### 4.7 `network`

```text
rules/network.md      # 常驻 · FishNet 封装边界、LockstepManager 参数、确定性约束
rules/hotfix.md       # 按需 · HybridCLR/Lua 注入点缺失，必须项目自建
skills/lockstep-setup/   # 配帧同步并验证逻辑帧推进
skills/hotfix-entry/     # 接一个热更入口
references/network-api.md
```

要点：`NetworkManager`、`StorageProvider`、`LuaModManager`、`HybridCLRAdapter` 都由项目注入或 `new`。`LockstepManager` 默认 15 fps、缓冲 3，`LockstepNetworkDriver` 在 Driver 内初始化；`FrameSyncManager` 为 null 或未启用时逻辑时间冻结。预测/回滚已有 Core 实现，缺 Unity 传输适配。确定性依赖固定点数学与固定逻辑帧，`HNFixedPoint` 当前只包装 Fixed64、无算术。

## 5. 跨层规范（`framework` 层承载）

1. **所有权**：谁创建谁释放。Driver 创建并释放 Log/Asset/Input/UI/Locale/Physics/FrameSync；项目创建并释放 Cutscene/Network/Storage/Quest/脚本引擎。
2. **引用池纪律**：跨场景必须 `ClearAll`；`IReference.Clear` 复位全部字段；禁止 `new` 池化类型。
3. **命名空间**：Core 用 `HN.Framework.Core.*`，Unity 用 `HN.Framework.Unity.*`，Editor 用 `HN.Framework.Editor.*`；UnityEngine 类型不得进 Core。
4. **风格差异**：框架自身私有字段混用 `m_`/`_`/camelCase，与 `unity-code-standards` 的 `_camelCase` 不一致；业务代码遵守 unity 层规范，改框架内部代码跟随所在文件。
5. **测试**：EditMode，命名 `方法_场景_预期`，临时对象 `HideAndDontSave` + `DestroyImmediate`。
6. **禁止**：改 `Vendor/`、改框架 asmdef、把工具源码塞进能力组、把宿主模型参数/权限写进组。

## 6. 与现有内容的边界

| 内容 | 归属 |
|---|---|
| Unity 引擎口径、MCP 优先、禁止 reimport all、全量测试限制 | `game-dev/unity`（继承，不重写） |
| C# 通用命名/格式/生命周期规范 | `game-dev/unity`（继承，本组只补框架特有约束） |
| 框架 API 用法、状态、坑 | 本组各层 |
| 框架源码、Vendor、工具实现 | 框架仓库，不复制 |
| unityMCP | 由 `game-dev/unity` 层声明，子层按祖先继承 |
| HNFlow 流程定义 | 暂不建，见 §10 |

## 7. 实施顺序

| 阶段 | 层 | 理由 |
|---|---|---|
| P0 | `framework`、`runtime` | 接入与基础运行时是所有人第一步 |
| P1 | `assets`、`gameplay` | 资源/配置决定可玩切片，玩法逻辑是主要内容 |
| P2 | `presentation`、`animation`、`network` | 按项目类型取舍，可延后 |

每层完成标准：

- `hnflow-stack validate` 无错误、`resolve --json` 无告警；
- 删除该子层后祖先与兄弟层仍自洽；
- 仅凭该层及祖先能完成声明的使用者任务，且不出现源码级实现描述；
- 引用的每个类型/方法都能在框架仓库找到，签名一致。

## 8. 交付物规模（粗估）

| 层 | rules | 常驻 | 按需 | skills | references |
|---|---|---|---|---|---|
| framework | 3 | 2 | 1 | 2 | 2 |
| runtime | 4 | 2 | 2 | 2 | 1 |
| assets | 2 | 1 | 1 | 3 | 1 |
| gameplay | 4 | 2 | 2 | 3 | 1 |
| presentation | 4 | 2 | 2 | 2 | 1 |
| animation | 3 | 2 | 1 | 2 | 1 |
| network | 2 | 1 | 1 | 2 | 1 |

合计 46 个文件（rules 22 = 常驻 12 + 按需 10、skills 16、references 8，不含 `group.json`）。纯查询内容不进技能，进 `references`。

最深层 `animation` 激活后注入的常驻规则：`framework` 2 + `runtime` 2 + `assets` 1 + `gameplay` 2 + `animation` 2 = 9 条正文，其余 5 条只出摘要行。

## 9. 激活与校验

```sh
# 只用工程接入与规范
hnflow-stack activate game-dev/unity/framework@0.1.0

# 动画：祖先 framework/runtime/assets/gameplay/presentation 隐式加载
hnflow-stack activate game-dev/unity/framework/runtime/assets/gameplay/animation@0.1.0

# 联机：祖先 framework/runtime 隐式加载
hnflow-stack activate game-dev/unity/framework/runtime/network@0.1.0

hnflow-stack validate
hnflow-stack resolve --json --project <项目>
```

子组版本必须等于组根版本 `0.1.0`，子组 `name` 必须等于目录名。激活只写被选中的组，祖先由解析器按路径补齐。

## 10. 风险与待确认

1. **编辑器分散**：不设独立 `editor` 层，工具按领域并入各层（见 §2.3）。若后续出现跨域工具（如统一构建报告），再上移到 `framework`。
2. **`assets` 的边界**：资源配置与管理并入同一层（Addressables、Sheet、本地化、存储）。若未来资源管线独立演进（CDN/热更资源包），可拆 `assets` 与 `content` 两层，届时 `gameplay` 挂到 `content` 下。
3. **半实现模块**：Asset、Physics、Combat、Quest、Inventory、MVC 只完成一半，方案是在所属层写"现状 + 替代路线"，不建占位组；P0 阶段以实际代码复核一次状态。
4. **时效**：组内容以 v1.0.0 代码为基线，`references` 记录核对版本与日期；框架升级时按 minor 修订。
5. **flows**：接入、新增模块、打包三条流程适合做 HNFlow 流程，等知识层稳定后再固化。
6. **示例代码**：只写片段级示例（类型名 + 调用顺序），不落完整可编译示例，避免与框架版本脱节。
