---
name: localize-text
description: 当用户要加多语言文本、接语言切换 UI、或出现"文本显示 key""切语言不刷新"时使用：文本表格式、key 约定、TextLocalizer 绑定与预加载
---

# 多语言文本

## 工作流

1. **加表项**：在 `locale_zhCN` 等语言表的 `entries` 里加 `{"key":"ui.start","value":"开始"}`，每种语言各加一份。
2. **绑文本**：场景 TMP 文本挂 `TextLocalizer`，填 key。
3. **取文本**：代码里 `world.LocaleProvider.GetString("ui.start")`。
4. **切语言**：`SetLocale(Locale.enUS)`；`SetLocale` 是 `async void`，不等待，靠事件刷新。
5. **预加载**：进主菜单前 `PreloadAllTablesAsync()`，避免首次切换卡顿。

## 表与 key

- 表 key 形如 `locale_zhCN`，默认语言中文。
- 可用语言：`zhCN`、`enUS`、`jaJP`、`koKR`、`zhTW`。
- key 命名 `<模块>.<用途>`：`ui.start`、`quest.accept`、`item.name_1001`。
- 改文案不改 key；删 key 前确认无引用。

## 图片/音频的多语言

`AssetLocalizer.LoadLocalizedAssetAsync<T>`：按当前语言加载对应资源变体。资源命名与分组要按语言区分，并由 `LocaleSelector` 驱动切换。

## 常见错误

| 现象 | 原因 | 处理 |
|---|---|---|
| 界面显示 `ui.start` | 表里缺该 key | 补 key；`GetString` 缺 key 返回 key 本身 |
| 切语言后界面不刷新 | 文本没用 `TextLocalizer` 绑定 | 改绑或用 `OnLocaleChanged` 手动刷新 |
| 首次切换卡顿 | 没预加载表 | 主菜单前 `PreloadAllTablesAsync` |
| 新语言无效 | 只加了表没加可用语言 | 同时更新可用语言列表 |

## 验收

- [ ] 所有玩家可见文本都有 key，代码里无字面量
- [ ] 五种语言列表齐全
- [ ] 切换语言后界面即时刷新
- [ ] 缺失 key 在测试期被记录

## 使用时机

新增文案、接语言切换、或排查文本不刷新时加载。
