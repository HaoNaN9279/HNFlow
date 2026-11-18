# 资源、配置表与本地化 API

路径相对框架仓库根。

## 资源

| 类型 | 成员 | 说明 |
|---|---|---|
| `IAssetManager` | `LoadSceneGroup` / `UnloadSceneGroup` / `PreloadSceneGroup` | 按 Addressables 场景标签；后者有缺陷，慎用 |
| `IAssetManager` | `LoadAsset(string)` / `ReleaseAsset(string)` | **返回 void**，取不回资源 |
| `IAssetManager` | `IsLoaded` / `GetReferenceCount` / `GetGroupProgress` / `GetLoadedAssetCount` | 状态与进度 |
| `AssetManager` | `Tick` / `LateTick` | 逐帧维护，Driver 已调度 |
| `AddressablesOperator` | `LoadAssetAsync<T>` | 唯一可用的取资源方法 |
| `AddressablesOperator` | `LoadAsset` | 打包后报错返回 null |

源码：`Runtime/HN.Framework.Core/Capability/Asset/`、`Runtime/HN.Framework.Unity/Capability/Asset/`

已知行为：释放延迟 30 秒；`ReleaseAsset` 只递减计数；场景标签记录从未写入。

## 配置表

| 类型 | 成员 |
|---|---|
| `SheetManager` | `LoadAllFromBinary()` → `RegisterTable(...)` → `GetTable` / `TryGet` |
| Sheet 数据类 | 由 Excel/Luban 导出，勿手改 |
| `AssetRef` | 单元格类型，运行时按 Addressables Label 解析 |

源码：`Runtime/HN.Framework.Core/Level/Logic/Sheet/`、`Runtime/HN.Framework.Unity/Capability/Sheet/`

编辑器：菜单 `HNFramework/Sheet/Sheet Editor`，含 TableModel、SchemaProvider、ExcelSourceParser、SheetGrid。

## 本地化

| 类型 | 成员 | 说明 |
|---|---|---|
| `LocaleManager` | ctor `(loader, available, fallback)` | Driver 已注入 |
| `LocaleManager` | `GetString(key)` | 缺 key 返回 key |
| `LocaleManager` | `SetLocale(Locale)` | `async void`，不等待 |
| `LocaleManager` | `PreloadAllTablesAsync()` | 进主菜单前调用 |
| `TextLocalizer` | 组件 | 绑定 TMP 文本与 key |
| `AssetLocalizer` | `LoadLocalizedAssetAsync<T>` | 多语言资源 |
| `LocaleSelector` | 组件 | 语言选择 UI |
| `AddressableStringTableLoader` | ctor `baseKey = "locale"` | 表 key `{baseKey}_{Code}` |

表格式：

```json
{"entries":[{"key":"ui.start","value":"开始"}]}
```

可用语言：`zhCN`（默认）、`enUS`、`jaJP`、`koKR`、`zhTW`。

源码：`Runtime/HN.Framework.Core/Capability/Localization/`、`Runtime/HN.Framework.Unity/Capability/Localization/`
