---
name: ui
description: UI 面板与弹窗的打开关闭、七层 Canvas 归属、Toast/引导/红点，以及重复打开堆积等约定。
priority: 10
---

# UI 面板与弹窗

## 打开与关闭

```csharp
await world.UIManager.PushAsync("ui/panel_main");          // 面板压栈
await world.UIManager.ShowAsync("ui/panel_hud");           // 显示不压栈
world.UIManager.ShowDialog("ui/dialog_confirm", OnConfirm, OnCancel);
world.UIManager.ShowToast("存档成功", 2f);
```

- 面板基类 `UIPanel`，生命周期 `OnOpen` / `OnClose` 由管理器调用（internal，业务不手动调）。
- 弹窗继承 `UIDialog`，Toast 继承 `UIToast`，引导继承 `UIGuide`。
- 关闭不是销毁：面板只 `SetActive(false)`，实例留在栈里。重复 `PushAsync` 同一个 key 会堆积实例，打开前先判断是否已开。

## 层级

七层 Canvas 由 Driver 创建并 `Initialize`，不要自己建 Canvas：

```text
背景 / 主界面 / 窗口 / 弹窗 / 提示 / 引导 / 顶层调试
```

- 面板归属层级由打开时所在的栈决定，需要自定义层级时用 `CreateCanvas(UILayer, int, string, bool)` 建独立 Canvas，再用 `SetCanvasSubOrder` 调序。
- 超出七层的临时界面（如全屏加载动画）自带 Canvas，但要放在引导层之下，避免遮挡。

## 动画

`UIAnimation.FadeIn` 等基础过渡自带；复杂动效用 Animator 或 DOTween，挂在面板内部，随面板显隐启停。

## 红点

`RedDotManager` 是纯 C# 类，**不在** `GameWorld` 里，需要项目自建并注入到流程。

## 约定

- 面板脚本只做显示与交互，业务数据从事件或服务取。
- 面板不持有场景对象引用；需要时通过事件通知。
- 所有界面文案用本地化 key。
- 面板销毁时退订全部事件。

## 检查清单

- [ ] 打开前判重，避免实例堆积
- [ ] 面板层级符合七层约定
- [ ] 关闭时退订事件、停止动画
- [ ] 文案走本地化
