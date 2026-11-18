---
name: hotfix
description: 需要热更 Lua 或 C#（HybridCLR）、生成 AOT 元数据、或热更代码不生效时读取：脚本引擎自建、初始化顺序、程序集划分与常见失败原因。
on_demand: true
priority: 20
---

# 脚本热更

## 两条路线

| 路线 | 适配器 | 适用 |
|---|---|---|
| Lua | `LuaModManager` | 逻辑脚本、MOD、可频繁迭代的内容 |
| C# 热更 | `HybridCLRAdapter` | 需要强类型与性能的业务代码 |

两者都实现 `IScriptEngine`：`Execute` / `RegisterGlobal` / `CallFunction`。

## 必须自建

Driver **不注入**任何脚本引擎。项目侧构造：

```csharp
var lua = new LuaModManager(modBasePath);
lua.Initialize();
world... // 通过自己的服务持有
```

- `LuaModManager` 构造参数是 MOD 根目录，可为 null（用默认路径）。
- `HybridCLRAdapter` 构造需传 `GameWorld`，初始化分两步：`Initialize()` 与 `InitializeHotUpdate()`；顺序不能反。

## HybridCLR 配置

1. 装 `com.code-philosophy.hybridclr`。
2. 配 `Assets/Project/EditorAssets/HybridCLRSettings.asset`：热更程序集列表、AOT 补充元数据程序集。
3. 菜单 `Tools/HNUnityFramework/HybridCLR/Generate AOT Metadata` 生成补充元数据。
4. 热更 DLL 与元数据一起进包。

热更程序集要放在 `Assets/Project/Scripts/` 下并加入设置列表；缺一个都还原失败。

## 初始化顺序

```text
HybridCLR 元数据加载 → 热更 DLL 加载 → InitializeHotUpdate → 注册入口
```

Lua 侧：启动脚本放在 MOD 根目录，`Execute` 后才可 `CallFunction`。

## 常见错误

| 现象 | 原因 | 处理 |
|---|---|---|
| 热更代码没生效 | 程序集没进列表 / DLL 没打包 | 核对设置与产物 |
| 元数据还原失败 | 缺 AOT 补充元数据 | 重新生成并列进包 |
| Lua 报找不到模块 | MOD 根目录不对 | 检查构造参数与实际路径 |
| 编辑器正常真机崩 | 只验证了编辑器加载 | 用真机包验证 |

## 检查清单

- [ ] 脚本引擎由项目自建并初始化
- [ ] HybridCLR 设置与程序集列表齐全
- [ ] 元数据与 DLL 同批产出
- [ ] 真机包验证过
