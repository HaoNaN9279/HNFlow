---
name: input-camera
description: 输入动作注册与屏蔽、输入资产替换，以及相机预设注册、切换、混合与震屏的使用约定。
priority: 20
---

# 输入与相机

## 输入

```csharp
world.InputManager.RegisterAction("move", OnMove);
world.InputManager.EnableActionMap("Player");
world.InputManager.SetControlScheme("KeyboardMouse");
world.InputManager.Blocker.Push();   // 屏蔽全部输入
```

- Driver 注入的是空 `InputActionAsset`（`{"maps":[],"controlSchemes":[]}`）。**必须替换**，否则所有注册的动作永不触发。
- 替换方式：在 `GameEntry` 里新建 `InputManager` 并赋给 `world.InputManager`，或直接改 Driver 子类的注入逻辑。
- `FindAction(..., throwIfNotFound: true)` 找不到会抛异常；运行时查动作前确认名字存在。
- `Blocker` 优先级固定为 0，任何一次 `Push` 都会屏蔽全部输入；弹窗、过场、加载时用，记得 `Pop`。
- 动作回调里的异常会被吞；关键逻辑自己 try/catch。

## 相机

```csharp
world.CameraManager.RegisterPreset(preset);
world.CameraManager.SetActiveCamera(preset);
world.CameraManager.BlendToCamera(target, duration);
world.CameraManager.Shake(strength, duration);
```

- 只有场景存在 `CinemachineBrain` 时 Driver 才注入相机管理器；没有 Brain 时 `world.CameraManager` 为 null。
- 相机预设（`CameraHandle`）通过 `RegisterCamera` 注册，切换用 `SetActiveCamera`，过渡用 `BlendToCamera`。
- 震屏 `Shake` / `StopShake` 成对；过场结束时停震。
- 相机跟随逻辑放表现层，不参与逻辑帧；逻辑代码只发"相机目标变更"事件。

## 常见错误

| 现象 | 原因 | 处理 |
|---|---|---|
| 输入无反应 | 空 InputActionAsset | 替换输入资产 |
| 输入一直屏蔽 | `Blocker.Push` 没有对应 `Pop` | 检查弹窗/过场退出路径 |
| 相机 API 为 null | 场景没有 `CinemachineBrain` | 加 Brain 或自建相机服务 |
| 切换相机闪跳 | 直接改了 Transform | 走 `BlendToCamera` |

## 检查清单

- [ ] 输入资产已替换
- [ ] 每个 `Blocker.Push` 都有 `Pop`
- [ ] 相机镜头有 Brain
- [ ] 震屏有停止调用
