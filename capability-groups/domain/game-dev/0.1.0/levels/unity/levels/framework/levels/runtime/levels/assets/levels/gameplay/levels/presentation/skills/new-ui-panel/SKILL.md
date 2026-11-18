---
name: new-ui-panel
description: 当用户要新增一个界面（主菜单、背包、设置、HUD）、做弹窗与提示、或界面重复打开/层级错乱时使用：面板类、层级归属、打开关闭与事件退订
---

# 新增一个 UI 面板

## 工作流

1. **选基类**：普通界面 `UIPanel`、确认框 `UIDialog`、飘字 `UIToast`、引导 `UIGuide`。
2. **做预制体**：放 `Assets/Project/RuntimeAssets/UI/`，打 Addressables 地址 `ui/panel_xxx`。
3. **写脚本**：`OnOpen` 里订阅事件、刷新数据；`OnClose` 里退订、停动画。
4. **打开**：`await world.UIManager.PushAsync("ui/panel_xxx")`；非栈式界面用 `ShowAsync`。
5. **判重**：打开前查询是否已打开，已开则只刷新不重开。
6. **文案**：全部走本地化 key。

## 层级归属

| 界面类型 | 层级 |
|---|---|
| 背景图、主界面 | 背景 / 主界面 |
| 背包、设置、图鉴 | 窗口 |
| 确认框、奖励弹窗 | 弹窗 |
| Toast、飘字 | 提示 |
| 新手引导遮罩 | 引导 |
| 调试面板 | 顶层调试 |

超出七层需求时用 `CreateCanvas` 建独立 Canvas 并 `SetCanvasSubOrder` 调序。

## 关闭语义

关闭只是 `SetActive(false)`，实例仍在栈里：

- 关闭后仍会收到事件（若没退订），必须在 `OnClose` 退订；
- 重开时 `OnOpen` 会再次执行，刷新逻辑要幂等。

## 常见错误

| 现象 | 原因 | 处理 |
|---|---|---|
| 界面叠加多层 | 重复 `Push` | 打开前判重 |
| 关闭后还会响应事件 | `OnClose` 没退订 | 补退订 |
| 弹窗盖不住 HUD | 放错层级 | 按上表归层 |
| 中文硬编码 | 没用本地化 key | 改 key |

## 验收

- [ ] 同一界面只存在一份
- [ ] `OnClose` 退订干净
- [ ] 层级符合约定
- [ ] 文案全部走 key

## 使用时机

新增界面、改界面结构、或界面出现叠加/残留事件时加载。
