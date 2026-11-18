---
name: load-release-asset
description: 当用户要在运行时加载预制体/贴图/音频等资源、或排查"资源加载为 null""内存涨不停"时使用：Addressables 直连写法、handle 生命周期与释放位置
---

# 加载与释放资源

## 结论先行

框架的 `AssetManager` **不返回资源**（加载方法都是 void）。需要实例就直连 Addressables。

## 工作流

1. **确定 key 与类型**：资源在 Addressables 里的地址（或 Label）与类型 `T`。
2. **异步加载**：`var handle = Addressables.LoadAssetAsync<T>(key); await handle.Task;`
3. **判空**：`if (handle.Status != AsyncOperationStatus.Succeeded) { 记录; return; }`
4. **使用**：`handle.Result`；实例化用 `Instantiate(handle.Result)`。
5. **存 handle**：把 handle 存在加载者字段里（流程状态、面板基类）。
6. **释放**：使用结束时 `Addressables.Release(handle)`，与加载一一对应。

## 场景加载

```csharp
var op = Addressables.LoadSceneAsync("scenes/battle", LoadSceneMode.Additive);
await op.Task;
// 卸载
await Addressables.UnloadSceneAsync(op).Task;
```

不要用 `AssetManager.LoadSceneGroup`：内部场景标签记录从未写入，过滤后为 0 条，静默不加载。

## 释放位置

| 加载位置 | 释放位置 |
|---|---|
| 流程 `Enter` | 流程 `Exit` |
| UI 面板 `OnOpen` | 面板 `OnClose` |
| 对象池 `Spawn` | 池 `Despawn` |
| 一次性临时资源 | 用完后立刻，别存字段 |

## 常见错误

| 现象 | 原因 |
|---|---|
| 打包后加载返回 null | 用了同步 `LoadAsset`（仅编辑器可用） |
| 编辑器正常、真机崩溃 | 没检查 `Status`，null 被继续使用 |
| 内存持续增长 | handle 没释放，或只释放了实例没释放 handle |
| 卸载后贴图变粉 | 释放了还在被引用的资源，检查是否多个使用方共享同一 handle |
| `LoadSceneGroup` 无反应 | 该方法的已知缺陷，改直连 Addressables |

## 验收

- [ ] 每次 Load 都有对应 Release，位置成对
- [ ] `Status` 检查齐全
- [ ] 未使用 `LoadSceneGroup`
- [ ] 共享资源由单一所有者释放

## 使用时机

新增资源加载、资源从编辑器切到真机出问题、或内存排查时加载。
