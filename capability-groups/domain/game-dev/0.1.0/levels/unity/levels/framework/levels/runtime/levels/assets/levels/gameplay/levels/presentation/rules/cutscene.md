---
name: cutscene
description: 需要播过场/演出、处理跳过与暂停、或过场 Actor 绑定不上时读取：CutsceneManager 自建、播放优先级、ActorRole 绑定与编辑器片段制作。
on_demand: true
priority: 30
---

# 过场与演出

## 必须自建管理器

Driver **不注入** `CutsceneManager`。使用前：

```csharp
world.CutsceneManager = new CutsceneManager(registry);
```

`registry` 是过场资源注册表，按 key 找到 Timeline 资产。不赋值则 `world.CutsceneManager` 为 null，播放调用直接崩。

## 播放

```csharp
world.CutsceneManager.Play(key, CutscenePriority.High, CutsceneSkipMode.Skippable, bindings);
world.CutsceneManager.Enqueue(next);
```

- 优先级高者插播，低者排队；`Enqueue` 是排队而不是打断。
- 跳过模式：`Skippable`（可跳过）/ 不可跳过。剧情关键演出用不可跳过。
- 暂停/恢复：`PauseAll` / `ResumeAll`；跳过当前：`SkipCurrent`；清队列：`StopAll` / `ClearQueue`。

## Actor 绑定

`CutsceneBindingMap` 把 Timeline 里的轨道绑定到场景对象，`CutsceneActor` 按 `ActorRole` 匹配：

- 演出前把角色按 role 注册进绑定表；
- 角色缺失时轨道静默不生效，检查绑定表而不是轨道本身；
- 同一角色在过场期间由 Timeline 驱动，逻辑层要暂停该角色的输入与 AI。

## 播放期间的全局影响

- 过场期间 `InputManager.Blocker.Push()`，结束时 `Pop`。
- 过场期间暂停逻辑更新或切到演出流程，不要在过场里跑战斗结算。
- 相机由 Timeline 控制，结束时恢复相机管理器的激活预设。

## 编辑器制作

菜单 `Cutscene Editor`：创建 / 编辑过场片段，轨道类型包括动画、音频、相机、激活、字幕等（`Runtime/HN.Framework.Unity/Capability/Cutscene/Tracks`）。

## 常见错误

| 现象 | 原因 | 处理 |
|---|---|---|
| 播放时 null 崩溃 | 没给 `world.CutsceneManager` 赋值 | 自建并赋值 |
| 角色不动 | ActorRole 未绑定 | 检查绑定表 |
| 过场后输入失灵 | Blocker 没 Pop | 结束路径补 Pop |
| 连续过场只播第一个 | 用了 `Play` 而不是 `Enqueue` | 排队用 `Enqueue` |

## 检查清单

- [ ] 管理器已自建并赋值
- [ ] 绑定表覆盖全部 actor
- [ ] 跳过/结束路径都恢复输入与相机
- [ ] 过场期间逻辑暂停
