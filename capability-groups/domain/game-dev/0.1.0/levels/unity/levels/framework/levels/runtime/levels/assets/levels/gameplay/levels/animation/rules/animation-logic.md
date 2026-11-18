---
name: animation-logic
description: 动画逻辑层：状态机定义、动画哈希、逐帧世界快照输入、状态请求与优先级、逻辑快照输出。
priority: 10
---

# 动画逻辑层

动画分两层：逻辑层只算"当前该是什么状态"，表现层负责播放。逻辑层不依赖 Animator。

## 定义状态机

```text
AnimationStateMachineDef
  └── AnimationStateDef[]（Name、Hash、ClipBinding、条件、优先级…）
```

- `Hash` 必须用 `AnimationHash.Compute("状态名")` 生成并**自己填**；0 表示 Empty，不能用作真实状态。
- `Hash` 与 `Name`、`ClipBinding` 三者要一致；`AddState` 只检查非 0 与重复，名字对不上不会报错，只会表现错乱。
- 状态机的定义是静态资源，运行时只读；改状态后要重新生成定义。

## 创建实例与逐帧输入

```csharp
var instance = world.AnimationLogicSystem.Create(def);   // 一实体一实例
instance.World = new AnimationWorldSnapshot { Velocity, MoveInput, Grounded, Tags };
```

- 逻辑实例是 `ITickable`，由 `AnimationLogicSystem` 统一推进。
- 每帧在推进前写入 `World` 快照；不写就是默认值，状态机会误判。
- 请求状态：`RequestState(hash, priority, duration, policy, restart)` 或 `Requests.Submit(...)`。
- **优先级低于当前状态且未要求 Restart 的请求会被丢弃**；需要强制切换时置 `restart: true`。
- 同一帧多条请求只应用优先级最高的一条，双缓冲，下一帧才生效。

## 输出

`AnimationStateSnapshot` 包含：`DominantStateHash`、`NormalizedTime`、`Speed`、`TransitionPolicy`、`Layers[]`、`Montages[]`、`Additives[]`、`Events[]`、`Version`，另有 `MotionIntent`。

- `Layers`/`Montages`/`Additives` 是**复用实例**，只有 `Version` 变化时才能重建缓存，否则拿到旧数据。
- 逻辑层 LOD 触发时会暂停该实例的 `Tick`（Culled → Paused），依赖状态推进的逻辑要考虑这一点。
- 池上限：Additive 最多 4 层，Montage 最多 2 个，超出被丢弃。

## 约定

- 逻辑代码只发请求、写快照，不直接操作 Animator。
- 状态命名统一前缀（`Locomotion.*`、`Combat.*`），便于哈希生成与排查。
- 动画事件（`Events[]`）由表现层消费，逻辑层只产出。

## 检查清单

- [ ] 每个状态都有非 0 `Hash`，且与名字一致
- [ ] 每帧写入 `World` 快照
- [ ] 强制切换用了 `restart`
- [ ] 读取快照前判断了 `Version`
