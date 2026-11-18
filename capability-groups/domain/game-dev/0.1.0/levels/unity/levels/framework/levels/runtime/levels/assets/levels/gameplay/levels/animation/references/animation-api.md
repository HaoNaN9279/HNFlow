# 动画 API 速查

路径相对框架仓库根。

## 逻辑层

| 类型 | 成员 | 说明 |
|---|---|---|
| `AnimationStateMachineDef` | 状态机定义 | `AnimationStateDef[]` |
| `AnimationStateDef` | `Name` / `Hash` / `ClipBinding` / 条件 | `Hash` 需自填 |
| `AnimationHash.Compute` | `static ... Compute(string)` | 0 = Empty |
| `AnimationLogicSystem` | `Create(def)` | 一实体一实例 |
| `AnimationLogicInstance` | `World` / `RequestState` / `Requests` | 逐帧输入与请求 |
| `AnimationLogicInstance` | `AnimationStateSnapshot` | 输出快照 |
| `AnimationWorldSnapshot` | `Velocity` / `MoveInput` / `Grounded` / `Tags` | 输入 |
| `AnimationStateSnapshot` | `DominantStateHash` / `NormalizedTime` / `Speed` / `TransitionPolicy` / `Layers` / `Montages` / `Additives` / `Events` / `Version` | 复用实例，判 `Version` |
| `MotionIntent` | 根运动意图 | 需自接 |

源码：`Runtime/HN.Framework.Core/Level/Logic/Animation/`

## 表现层

| 类型 | 说明 |
|---|---|
| `AnimationLogicAgent` | `Initialize(def)`，内部创建并注册逻辑实例 |
| `AnimationLodDriver` | `TickLod()`，按距离暂停逻辑 |
| `AnimationRepresentation` | `ApplySnapshot()`；只消费 Layers + Montages |
| `InertializationBlender` | 存在，无人引用 |

源码：`Runtime/HN.Framework.Unity/Level/View/Animation/`

## 装配顺序

```text
LateUpdate:
  PushWorldSnapshot()
  AnimationLodDriver.TickLod()
  AnimationRepresentation.ApplySnapshot()
```

## 池上限

Additive 4 层、Montage 2 个。

## Playable 缺陷

| 编号 | 现象 |
|---|---|
| UUM-30899 / UUM-14492 | `Playable.Pause()` 异常，用 `SetSpeed(0)` |
| UUM-34442 | `AnimationScriptPlayable` 多端口无效 |
| UUM-33944 | 权重 ≠ 1 时属性流失效 |
| UUM-33177 | 连续 `Seek` 一次性施加根运动 |
| UUM-36098 | Humanoid 下 velocity 无效 |
| UUM-33952 | `timeScale` 污染手写根运动 |
| UUM-31822 | `applyRootMotion=false` 时 TransformStreamHandle 位置异常 |

## 编辑器

菜单 `HN/Framework/Animation/*`：调试器、面部、IK Rig、ControlRig、重定向烘焙、时间轴标注、压缩分析。

源码：`Runtime/HN.Framework.Editor/Animation/`

## 设计文档

框架仓库 `架构~/动画模块/` 下 24 篇，覆盖状态机、Montage、混合、IK、LOD、预测同步等设计说明。
