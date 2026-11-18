---
name: animate-character
description: 当用户要给角色做移动/攻击/受击动画、接动画状态机、或出现"动画不切换/切了又弹回"时使用：状态定义、哈希、请求优先级与表现装配
---

# 给角色接动画

## 工作流

1. **定状态**：列出需要的状态（Idle、Run、Jump、Attack1…），统一命名前缀。
2. **建定义**：`AnimationStateMachineDef` + 每状态一个 `AnimationStateDef`，`Hash = AnimationHash.Compute(名字)`，绑定对应 Clip。
3. **配条件**：移动速度、是否落地、输入方向、标签条件。
4. **装配表现**：场景角色上挂 `AnimationLogicAgent`，`Initialize(def)`。
5. **喂输入**：每帧写 `instance.World`（速度、输入、Grounded、Tags）。
6. **发请求**：状态切换用 `RequestState(hash, priority, duration, policy, restart)`。
7. **接事件**：攻击判定、脚步声从 `Events[]` 里取，需自写分发。

## 优先级策略

| 状态类型 | 建议优先级 |
|---|---|
| 受击 / 死亡 | 最高，带 `restart` |
| 攻击 / 技能 | 高 |
| 跳跃 / 落地 | 中 |
| 移动 / 待机 | 低 |

优先级低于当前状态且未 `restart` 的请求会被丢弃——"点了没反应"通常是这个原因。

## 常见错误

| 现象 | 原因 | 处理 |
|---|---|---|
| 状态切不过去 | 优先级低且无 `restart` | 提高优先级或置 `restart` |
| 播放了错误的动画 | 哈希与状态名不一致 | 用 `Compute(名字)` 重算 |
| 有两份逻辑实例在跑 | 既 `Initialize` 又手动 `Create` | 只保留一种 |
| 角色漂移 | 根运动与位移逻辑双驱动 | 二选一 |
| 状态表现卡住 | 逻辑 LOD 暂停 | 检查 LOD 距离设置 |

## 验收

- [ ] 所有状态哈希非 0 且与名字一致
- [ ] 每帧写入世界快照
- [ ] 高低优先级切换行为符合预期
- [ ] 事件通道已接入

## 使用时机

新增角色动画、接状态机、或排查动画不切换时加载。
