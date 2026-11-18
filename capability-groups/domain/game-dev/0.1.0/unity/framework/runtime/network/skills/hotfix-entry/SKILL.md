---
name: hotfix-entry
description: 当用户要加热更（Lua 或 C#）、配置 HybridCLR、或热更后代码没生效时使用：引擎自建、程序集与元数据配置、初始化顺序与真机验证
---

# 接入热更

## 先选路线

- 逻辑脚本、MOD、频繁改内容 → Lua（`LuaModManager`）。
- 需要强类型、性能敏感的业务 → C# 热更（`HybridCLRAdapter`）。

## 工作流（C# / HybridCLR）

1. **装包**：`com.code-philosophy.hybridclr`。
2. **划程序集**：热更代码单独 asmdef（如 `Game.HotUpdate`），放 `Assets/Project/Scripts/` 下。
3. **配设置**：`HybridCLRSettings.asset` 填热更程序集与 AOT 补充元数据程序集。
4. **生成元数据**：菜单 `Tools/HNUnityFramework/HybridCLR/Generate AOT Metadata`。
5. **自建适配器**：`new HybridCLRAdapter(world)`，先 `Initialize()` 再 `InitializeHotUpdate()`。
6. **打包**：热更 DLL 与元数据一起进包，Addressables 或 StreamingAssets 皆可。
7. **真机验证**：编辑器通不代表真机通。

## 工作流（Lua）

1. 准备 MOD 根目录，放启动脚本。
2. `new LuaModManager(modBasePath)` → `Initialize()`。
3. `Execute` 启动脚本，再 `CallFunction` 调入口。
4. 需要暴露给 Lua 的全局用 `RegisterGlobal`。

## 初始化顺序

```text
元数据 → DLL → InitializeHotUpdate → 注册入口 → 允许业务调用
```

顺序颠倒会得到"找不到类型"或空实现。

## 常见错误

| 现象 | 原因 |
|---|---|
| 热更类找不到 | 程序集没进设置列表 |
| 元数据还原失败 | 缺 AOT 补充元数据，或未随包发布 |
| Lua 找不到模块 | MOD 根目录配置错 |
| 只在真机崩 | 未在真机包验证 |

## 验收

- [ ] 热更程序集独立且已配置
- [ ] 元数据与 DLL 同批生成
- [ ] 初始化顺序正确
- [ ] 真机包验证通过

## 使用时机

首次接热更、加新热更程序集、或热更不生效时加载。
