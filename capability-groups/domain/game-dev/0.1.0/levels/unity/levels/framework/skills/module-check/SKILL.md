---
name: module-check
description: 当用户要实现某功能、但不确定框架里这个模块能不能用、或遇到"接口存在但没效果"时使用：核对模块实现状态并给出替代路线
---

# 模块状态核对

框架里同名接口/设置资产存在，不等于功能可用。动手前先核对，避免按文档写完发现是空实现。

## 工作流

1. **定位模块**：功能属于哪个模块（输入、UI、战斗、动画…）。
2. **查状态表**（见 `entry` 规则）：完整 / 部分 / 未实现。
3. **查源码**：到框架仓库对应目录确认——有接口不一定有实现。
4. **给结论**：能用就写；部分/未实现则给出替代路线，并明确告诉用户"这块框架里没有"。

## 判断方法

```text
Runtime/HN.Framework.Core/Capability/<模块>/     接口与纯逻辑
Runtime/HN.Framework.Unity/Capability/<模块>/    引擎实现
Runtime/HN.Framework.Core/Level/Logic/<模块>/    玩法数据与逻辑
Runtime/HN.Framework.Unity/Level/View/<模块>/    表现层
Runtime/HN.Framework.Editor/<模块>/              编辑器工具
```

- 目录不存在 → 未实现。
- 只有一个 `Settings` 子目录 → 只有配置，没有运行时。
- 接口方法体是空的 / `Debug.LogWarning` + return → 部分实现。
- `GameWorld` 上没有对应属性 → Driver 不注入，需要项目自建。

## 替代路线速查

| 需求 | 框架现状 | 替代 |
|---|---|---|
| 音频播放 | 只有 `AudioSettings`，无管理器 | 直接用 `AudioSource` + 自行封装的播放服务 |
| 场景流送（开放世界分块） | 未实现 | Addressables 场景组手动加载释放 |
| 时间/天气 | 未实现 | 项目自写时间服务 |
| 性能监控 | 未实现 | Profile Analyzer + 自定义统计 |
| 配置表 | 完整（`Level.Logic.Sheet`） | — |
| 逻辑/表现同步 | 部分（无视图工厂接线） | 自行把 `EntityManager` 与 `EntityView` 连起来 |
| 资源加载 | 部分（`IAssetManager` 取不回资源） | 直接 `Addressables.LoadAssetAsync<T>` |

## 报告格式

给用户的结论必须包含：

- 模块名与状态（完整 / 部分 / 未实现）；
- 依据（源码路径 + 关键签名或空实现位置）；
- 建议路线（用框架哪一层，或自建）。

## 使用时机

动手写一个不熟悉的模块前、或用户说"文档里有但没反应"时加载。已知状态可直接按状态表执行。
