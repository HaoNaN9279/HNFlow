---
name: network
description: 帧同步与网络连接：LockstepManager 帧率与缓冲、消息总线、FishNet 传输、预测回滚与确定性要求。
priority: 10
---

# 网络与帧同步

框架的网络能力分两块：锁步帧同步（`FrameSyncManager`）与 FishNet 传输。二者由 Driver 在 `InitializeFrameSync()` 里接起来。

## 帧同步

```text
LockstepManager（默认 15 Hz，缓冲 3 帧）
  + FishNetMessageBus
  + LockstepNetworkDriver
```

- 帧率与缓冲在初始化时设定；改帧率等于改逻辑节奏，联机双方必须一致。
- `HNLogicTime` 只由锁步推进；所有玩法逻辑读逻辑帧时间，不读 `Time.deltaTime`。
- 缓冲帧用于吸收网络抖动；设太小会卡顿，太大输入延迟。

## 确定性要求

锁步下所有客户端跑同一份逻辑，任何非确定性都会导致不同步：

| 禁止 | 替代 |
|---|---|
| `UnityEngine.Random` / `System.Random` | `HNRandom`（按帧种子） |
| `float` 参与判定 | `FixedMathSharp` 定点数 |
| `Dictionary` 遍历顺序参与逻辑 | 排序后的数组 / 固定遍历顺序 |
| 物理引擎浮点结果 | 自行算碰撞，或固定步长 + 定点 |
| 依赖 `Time.deltaTime` | 固定逻辑步长 |

## FishNet

- FishNet 以源码形式在 `Runtime/HN.Framework.Unity/Vendor/FishNet`，按 FishNet 官方文档使用，不改它的代码。
- 消息走框架的 `Messages` 与 `FishNetMessageBus`，不要绕过总线自己发包。
- 连接管理与重连在项目侧，框架只提供消息与锁步驱动。

## 预测回滚

- `Network/Prediction` 提供预测与回滚的数据结构，**没有 Unity 传输适配**，需要自己接 FishNet 的 RPC。
- 回滚要求状态可序列化；用 `MemoryPack` 序列化需要 `[MemoryPackable]`。
- 回滚期间表现层要能瞬移重置，不要在表现层做不可逆的插值。

## 常见错误

| 现象 | 原因 |
|---|---|
| 联机不同步 | 用了随机数/浮点/遍历顺序 |
| 输入延迟忽大忽小 | 缓冲帧设置不当 |
| 回滚后画面抽搐 | 表现层插值没重置 |
| 掉线后状态错乱 | 重连未重建逻辑状态 |

## 检查清单

- [ ] 逻辑里没有非确定性来源
- [ ] 双方帧率与缓冲一致
- [ ] 消息走总线
- [ ] 回滚时表现层有重置路径
