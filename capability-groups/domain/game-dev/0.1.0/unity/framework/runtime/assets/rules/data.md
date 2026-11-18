---
name: data
description: 需要读配置表（Excel/Luban 导出）、用 AssetRef 单元格引用资源、或加本地化文本时读取：表加载顺序、key 约定、文本表格式与获取方式。
on_demand: true
priority: 20
---

# 配置表与本地化

## 配置表

```text
Excel/Luban 源表
  → 导出 binary + C# 数据类
  → StreamingAssets 或 Addressables 分组
  → SheetManager.LoadAllFromBinary()
  → RegisterTable(...)
  → GetTable / TryGet
```

- `LoadAllFromBinary` 先执行，`RegisterTable` 按表名注册，之后才能 `GetTable`。
- 表名重复、表缺失、键不存在都会抛异常——启动阶段加载，失败即视为配置错误，不要 try 掉继续跑。
- 数据结构由导出工具生成，**不要手改**生成类；改表改源 Excel/Luban 定义再重导。
- `AssetRef` 类型的单元格在编辑器里拖资源会写入资源路径，运行时按 Addressables Label 解析，所以被引用的资源必须打上对应 Label，否则解析为空。

## 表的使用约定

- 表在启动流程加载一次，之后只读；不要运行时改表数据。
- 键类型统一（字符串或 int），同一张表不要混用。
- 查表封装成项目侧服务（如 `ConfigService`），业务代码不直接散落 `GetTable`。

## 本地化

```text
LocaleManager 由 Driver 注入，默认 zhCN，
可用语言 zhCN / enUS / jaJP / koKR / zhTW，
语言表 key 形如 locale_zhCN，
表内容 {"entries":[{"key":"...","value":"..."}]}
```

- 取文本：`world.LocaleProvider.GetString("ui.start")`。
- 切换语言：`SetLocale(Locale.zhCN)` —— 内部是 `async void`，调用后不会等待，界面刷新靠 `TextLocalizer` 的事件。
- 预加载全部表：`PreloadAllTablesAsync()`，进主菜单前调用，避免首次切换卡顿。
- 场景文本：`TextLocalizer` 挂到 TMP 文本上绑定 key；图片类用 `AssetLocalizer.LoadLocalizedAssetAsync<T>`。
- 语言选择 UI 用 `LocaleSelector`，不要自己维护语言列表。
- 文本表存放位置由 `AddressableStringTableLoader` 的 baseKey 决定（默认 `locale`），新增语言要同时加表与可用语言列表。

## 约定

- 所有玩家可见文本走本地化 key，代码里不写中文/英文字面量。
- key 用 `<模块>.<用途>` 命名（`ui.start`、`quest.accept`），改文案不改 key。
- 缺失 key 时 `GetString` 不抛异常，返回 key 本身；测试阶段要盯这个现象。

## 检查清单

- [ ] 表在启动流程加载，失败直接报错停下
- [ ] 被 `AssetRef` 引用的资源已加 Addressables Label
- [ ] 玩家可见文本都走了本地化 key
- [ ] 新语言同时补了文本表与可用语言列表
