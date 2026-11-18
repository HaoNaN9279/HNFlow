---
name: playable-limits
description: 用 Playable API 或 Timeline 自定义动画时读取：Unity 已知缺陷清单（Pause、端口、权重、根运动、timeScale）与规避写法。
on_demand: true
priority: 30
---

# Playable 使用限制

Unity 2022.3 下的已知问题与规避方式。遇到"播放行为跟预期不一样"先查这张表。

## 禁止与替代

| 操作 | 问题 | 规避 |
|---|---|---|
| `Playable.Pause()` | UUM-30899 / UUM-14492，暂停后恢复异常 | 用 `SetSpeed(0)` 冻结，`SetSpeed(1)` 恢复 |
| `AnimationScriptPlayable` 多输入端口 | UUM-34442，只有 1 个输入端口有效 | 只保留单输入，混合在作业内做 |
| 权重设 0 | UUM-33944，权重非 1 时部分属性流失效 | 权重夹到 `[0.0001, 1]` |
| 连续 `Seek` | UUM-33177，一次性施加全部根运动 | 每帧只 Seek 一次，或禁根运动自行驱动 |
| Humanoid + velocity | UUM-36098，velocity 无效 | 改用根运动或手动位移 |
| `timeScale` 与手写根运动 | UUM-33952，两者叠加导致位移翻倍 | 二选一 |
| `applyRootMotion = false` + `TransformStreamHandle` | UUM-31822，位置异常 | 保持 `applyRootMotion = true` 或在播放后重设位置 |

## 混合注意

- 权重为 0 的层直接移除，不要留在图里。
- 层数超过 4 层时性能显著下降，优先合并。
- `AnimationScriptPlayable` 的作业里不要访问 UnityEngine 对象。

## 调试

- 菜单 `HN/Framework/Animation/*` 下有 Playable 调试窗口，可查看当前图结构与权重。
- 表现异常先确认是逻辑快照错还是 Playable 应用错：断开逻辑层（手动设状态）单独看表现。

## 检查清单

- [ ] 没有直接调用 `Playable.Pause()`
- [ ] 权重都在有效区间
- [ ] 根运动只有一个驱动源
- [ ] 每帧 Seek 不超过一次
