---
name: cutscene-play
description: 当用户要加入过场动画/剧情演出、做可跳过剧情、或过场播完输入失灵时使用：管理器自建、Timeline 片段绑定、跳过与恢复
---

# 播放一段过场

## 前置条件

- 已用 `Cutscene Editor`（或 Timeline）做好片段，并登记到过场注册表。
- 场景里角色有明确的 `ActorRole` 标记。

## 工作流

1. **建管理器**：`world.CutsceneManager = new CutsceneManager(registry);`（Driver 不注入）。
2. **建绑定表**：`CutsceneBindingMap` 里按 role 填场景对象。
3. **屏蔽输入**：播放前 `world.InputManager.Blocker.Push()`。
4. **播放**：`Play(key, priority, skipMode, bindings)`；连播用 `Enqueue`。
5. **跳过/结束**：处理 `SkipCurrent` 与自然结束两条路径，都要 `Pop` 输入、恢复相机、恢复逻辑。
6. **收尾**：`StopAll` 清残留，`ClearQueue` 清排队。

## 优先级规则

- 高优先级插播，低优先级排队。
- 同类过场不要靠优先级抢占，用 `Enqueue`。

## 必须成对的操作

| 播放前 | 结束后 |
|---|---|
| `Blocker.Push()` | `Blocker.Pop()` |
| 暂停角色输入/AI | 恢复 |
| 切换演出相机 | 恢复激活预设 |

跳过路径最容易漏 `Pop`，写完先测"立刻跳过"。

## 验收

- [ ] 管理器已赋值
- [ ] 全部 actor 有绑定
- [ ] 跳过与正常结束都恢复输入与相机
- [ ] 连续过场能排队播放

## 使用时机

加剧情演出、做过场跳过、或过场后操作失灵时加载。
