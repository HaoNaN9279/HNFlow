---
name: framework-onboarding
description: 当用户需要把框架接入一个空 Unity 工程、生成 GameEntry 与启动场景、或排查"框架装了但游戏跑不起来"时使用
---

# 框架接入 — 从空工程到可运行的 GameEntry

把 HNUnityFramework 接入一个新 Unity 工程，产出可编译、可运行的最小骨架。

## 前置条件

- Unity 2022.3 或更高，工程为内置渲染管线或 URP 均可。
- 已安装 HybridCLR（`com.code-philosophy.hybridclr`）。缺它编辑器程序集编译失败，后续步骤全部卡住。
- 有 Git 访问权限可拉取框架包。

## 工作流

1. **装包**：`Packages/manifest.json` 加 `"com.hn.framework": "https://github.com/HaoNaN9279/HNUnityFramework.git#v1.0.0"`，或 Package Manager 的 Add package from git URL。
2. **装依赖**：Addressables、Cinemachine、Input System、Timeline、TextMeshPro、Newtonsoft Json。Input System 首次导入询问时选 Enable。
3. **部署**：菜单 `HNFramework/Deploy Framework`。先保存当前场景——它会新开空场景。
4. **确认产物**：`Assets/Project/` 三段目录、`RuntimeAssets/Core/` 下 8 个设置资产、`Scripts/Runtime/GameEntry.cs`、启动场景。
5. **写入口**：继承 `GameWorldDriver`，在 `OnRegisterGameModules` 里注册自定义模块。
6. **跑起来**：进启动场景播放，Console 无异常即骨架就绪。

## 最小入口模板

```csharp
using HN.Framework.Core.Driver.GameWorld;
using HN.Framework.Unity.Driver.Platform;

public sealed class GameEntry : GameWorldDriver
{
    protected override void OnRegisterGameModules(GameWorld world)
    {
        base.OnRegisterGameModules(world);
        // world.ProcedureManager.AddState<BootState>("Boot");
        // world.ProcedureManager.Start("Boot");
    }
}
```

## 必须替换的注入

Driver 注入的输入模块带着空的 `InputActionAsset`（`{"maps":[],"controlSchemes":[]}`）。不改就是全部输入无效：

1. 新建 `.inputactions` 资产；
2. 在 `GameEntry` 里构造 `InputManager` 并用 `world.InputManager = ...` 覆盖；
3. 或直接改 Driver 子类的注入逻辑。

相机模块只在场景存在 `CinemachineBrain` 时才注入；没有 Brain 时 `world.CameraManager` 为 null。

## 常见错误

| 现象 | 原因 | 处理 |
|---|---|---|
| 编译报 `HybridCLR.Editor` 找不到 | 没装 HybridCLR | 装包后重新导入 |
| `NullReferenceException` 出现在 `World.*` | 在 `OnRegisterGameModules` 之前访问 | 把代码移到 `Initialize` 之后 |
| 输入无反应 | 空 InputActionAsset | 替换输入资产 |
| 相机 API 为 null | 场景无 CinemachineBrain | 加 Brain 或自行注入相机模块 |
| 过场播不出来 | Driver 不注入 `CutsceneManager` | 自行构造并赋值给 `world.CutsceneManager` |

## 使用时机

新工程首次接入、迁移到框架、或复现"跑不起来"时加载。已有工程只改业务代码时不需要。
