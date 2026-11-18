---
name: assets
description: 资源加载与释放纪律：AssetManager 的实际能力边界、Addressables 直连写法、场景组、引用计数与释放时机。
priority: 10
---

# 资源加载与释放

## 先认清能力边界

`IAssetManager` 的全部加载方法**返回 void**，没有取回资源的 API：

```text
LoadSceneGroup / UnloadSceneGroup / PreloadSceneGroup
LoadAsset(string key) / ReleaseAsset(string key)
IsLoaded / GetReferenceCount / GetGroupProgress / GetLoadedAssetCount
```

因此：

- 需要在代码里拿到资源实例时，**直接用 Addressables API**，不要绕 `AssetManager`。
- `AssetManager` 只适合"加载/卸载场景组、统计进度"这类不关心返回值的操作。
- 打包后 `AddressablesOperator.LoadAsset`（同步）会 `Debug.LogError("AddressablesOperator does not support synchronous loading.")` 并返回 null；只有 `LoadAssetAsync<T>` 可用。编辑器下因为走 AssetDatabase 才看起来正常。

## 推荐写法

```csharp
var handle = Addressables.LoadAssetAsync<GameObject>("ui/panel_main");
await handle.Task;
if (handle.Status != AsyncOperationStatus.Succeeded) { /* 记录并返回 */ }
var prefab = handle.Result;
// 用完
Addressables.Release(handle);
```

- 一律用 handle 释放，不要用资源实例反查。
- `Status` 必须检查；失败时不要把 null 传下去。
- 同一 key 多次加载由 Addressables 自身去重，但仍要成对 Release。

## 场景组

- `LoadSceneGroup(name)` 按 Addressables 里的场景标签加载，`UnloadSceneGroup(name)` 卸载。
- 已知缺陷：`AssetManager` 内部的场景标签记录从未写入，`LoadSceneGroup` 过滤后恒为 0 条并静默返回。加载场景请直接 `Addressables.LoadSceneAsync`，不要依赖这个方法。
- 加载/卸载场景组后调用一次 `GetGroupProgress` 观察进度，不要轮询到死循环。

## 引用计数与释放

- `AssetManager` 的计数只是递减：命中缓存时 `ReleaseAsset` 不加判断地减，重复释放不会报错但计数会错。业务侧自己保证成对。
- 真正的资源释放延迟 30 秒，属正常行为，不是泄漏。
- 流程 `Exit` 与场景卸载时集中释放：把本流程加载的 handle 存在流程字段里，逐个 Release。

## 目录与分包

- 运行时资源放 `Assets/Project/RuntimeAssets/`，Addressables 自动更新只扫这个目录。
- 按模块建 Addressables 分组（UI、角色、场景、音频…），不要所有资源塞一个组。
- 大资源用远端分组时，先确认 `AddressableAssetsData` 的远端加载模式已配置。

## 检查清单

- [ ] 需要资源实例的地方用 `Addressables.LoadAssetAsync`
- [ ] 每个 handle 都有对应 `Release`
- [ ] 检查了 `handle.Status`
- [ ] 场景加载没走 `LoadSceneGroup`
- [ ] 资源目录在 `RuntimeAssets` 下
