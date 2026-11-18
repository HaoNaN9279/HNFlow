# 表现层 API 速查

路径相对框架仓库根。

## UI

| 成员 | 签名 | 说明 |
|---|---|---|
| `UIManager.PushAsync` | `Task PushAsync(string path)` | 压栈打开 |
| `UIManager.ShowAsync` | `Task ShowAsync(string path)` | 显示不压栈 |
| `UIManager.ShowDialog` | `(string path, Action onConfirm, Action onCancel)` | 确认框 |
| `UIManager.ShowToast` | `(string message, float duration = 2f)` | 飘字 |
| `UIManager.StartGuide` | 引导 | 新手引导 |
| `UIManager.CreateCanvas` | `(UILayer layer, int order, string name, bool ...)` | 自定义 Canvas |
| `UIManager.SetCanvasSubOrder` | 调整子层顺序 | — |
| `UIPanel` | `OnOpen` / `OnClose`（internal） | 面板基类 |
| `UIDialog` / `UIToast` / `UIGuide` | 基类 | 弹窗 / 提示 / 引导 |
| `UIAnimation.FadeIn` | 过渡 | 基础动画 |
| `RedDotManager` | 纯 C# | 不在 `GameWorld`，需自建 |

源码：`Runtime/HN.Framework.Core/Capability/UI/`、`Runtime/HN.Framework.Unity/Level/View/UI/`

## 输入

| 成员 | 说明 |
|---|---|
| `IInputManager.RegisterAction(string, Action<InputContext>)` | 注册动作回调 |
| `UnregisterAction` / `EnableActionMap` / `DisableActionMap` / `SetControlScheme` | 映射与方案 |
| `Blocker` | 优先级固定 0，`Push` 即全屏蔽 |
| Driver 注入 | 空 `InputActionAsset`，必须替换 |

源码：`Runtime/HN.Framework.Core/Capability/Input/`、`Runtime/HN.Framework.Unity/Capability/Input/`

## 相机

| 成员 | 说明 |
|---|---|
| `ICameraManager.RegisterPreset` / `SetActiveCamera` / `GetActiveCamera` | 预设管理 |
| `ICameraManager.BlendToCamera` | 过渡切换 |
| `ICameraManager.Shake` / `StopShake` | 震屏 |
| `CameraHandle RegisterCamera(...)` | 注册相机 |

前提：场景需有 `CinemachineBrain` 才被 Driver 注入。

源码：`Runtime/HN.Framework.Core/Capability/Camera/`、`Runtime/HN.Framework.Unity/Capability/Camera/`

## 过场

| 成员 | 签名 |
|---|---|
| `ICutsceneManager.Play` | `(string key, CutscenePriority, CutsceneSkipMode, CutsceneBindingMap)` |
| `Enqueue` | 排队播放 |
| `StopAll` / `ClearQueue` | 停止与清队列 |
| `PauseAll` / `ResumeAll` | 暂停恢复 |
| `SkipCurrent` | 跳过当前 |
| `CutsceneActor` | 按 `ActorRole` 绑定 |

**Driver 不注入**：需 `new CutsceneManager(registry)` 赋给 `world.CutsceneManager`。

源码：`Runtime/HN.Framework.Core/Capability/Cutscene/`、`Runtime/HN.Framework.Unity/Capability/Cutscene/`（含 Tracks）

## 实体视图

| 类型 | 说明 |
|---|---|
| `EntityView` | 携带 `EntityId` / `EntityDefId` |
| `PropertyBinder` | 抽象基类，需派生 |
| `ViewFactory` | 存在但未接线；`CreateView` 的 `entityId` 恒为 0 |

源码：`Runtime/HN.Framework.Unity/Level/View/EntityView.cs`、`Runtime/HN.Framework.Unity/Level/View/Binding/`、`Runtime/HN.Framework.Unity/Level/ViewFactory/`

编辑器：`HNFramework/Cutscene Editor`、`Window/HNUnityFramework/Input Debugger`（采集未接通）。
