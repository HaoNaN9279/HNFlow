---
name: build
description: 需要部署工程目录、生成设置资产、配置 Addressables 分组、执行打包或处理 HybridCLR 构建时读取：Deploy 菜单、构建管线四步、版本号来源与已知缺口。
on_demand: true
priority: 30
---

# 工程部署与打包

## 首次部署

菜单 `HNFramework/Deploy Framework` 一次性完成：

- 创建目录 `Assets/Project/{RuntimeAssets/{Core,Scenes,Shaders,ConfigData,UI},EditorAssets,Scripts/{Editor,Runtime}}`；
- 生成 8 个设置资产到 `Assets/Project/RuntimeAssets/Core/`（Global、AI、Asset、Audio、Cutscene、Localization、Network、UI）；
- 生成 `Assets/Project/Scripts/Runtime/GameEntry.cs` 与启动场景；
- 建立 Addressables 组预设。

注意：Deploy 会以 `NewScene(Single)` 打开新场景，**当前未保存的编辑会丢失**。部署前先保存。

重复执行是幂等的，但会覆盖同路径的生成物；已改过的 `GameEntry` 先备份。

## 设置资产

- 所有模块设置统一走 `ScriptableObject` + `HNModuleSettingsUtility.GetOrCreateSettings<T>()` + `[SettingsProvider]`，共 10 个设置页，入口在 `Project Settings`。
- 已存在的设置资产不要删；丢失时对应模块会用代码默认值，但 UI 上的配置项会消失。
- 构建设置在 `Assets/Editor/BuildPipeline/Settings/BuildPipelineSettings.asset`。
- HybridCLR 配置在 `Assets/Project/EditorAssets/HybridCLRSettings.asset`。

## 目录约定

```text
Assets/Project/RuntimeAssets/   运行时要打进包的内容（Addressables 更新只扫这里）
Assets/Project/EditorAssets/    仅编辑器资源
Assets/Project/Scripts/         运行时代码与编辑器代码
AddressableAssetsData/          Addressables 分组配置
StreamingAssets/                热更与配置表产物
```

运行时资源放错到 `Assets/Project` 之外时，Addressables 自动更新不会扫到。

## 打包管线

菜单 `HNFramework/Build Pipeline`。四步顺序固定：

1. `PreBuildValidation`：扫描整个 `Assets/`，有 Error 且勾了 `BlockBuild` 就中止。可以先单独跑 `Asset Validator` 定位。
2. Addressables 构建：通过反射调用 Addressables 接口，失败会回退到菜单手动执行并给出提示。
3. Player 构建：Build Settings 里必须有场景，否则直接失败。
4. `PostBuild`：只清理 `Temp/AddressablesBuild`，不产报告。

已知缺口：

- `Build Reports` 窗口永远为空（`BuildReportGenerator` 未被调用）。
- 版本配置路径指向 `Assets/Editor/...`，默认没人创建；首次打开构建窗口会 `CreateAsset` 失败、版本号为空。需要版本号时先手动建 `VersionConfig`。
- `VersionConfigPath` 与 `AutoGenerateBuildManifest` 从未被读取。

## Addressables 分组

- `HNFramework/Update Addressable Groups` 按目录约定重建分组，只扫 `Assets/Project/RuntimeAssets`。
- 手动加进 Addressables 的资源在下次执行该菜单时会被移出；自定义分组请放在 `RuntimeAssets` 之外的独立分组并加 `Pack` 标记。
- 冗余资源用 `HNFramework/Redundancy Cleaner` 清理，它把重复资源移到备份目录而不是删除，确认无误后再手动删。

## HybridCLR

- 菜单 `Tools/HNUnityFramework/HybridCLR/Generate AOT Metadata` 生成补充元数据。
- 先装官方 HybridCLR 包并配好 `HybridCLRSettings.asset`，否则菜单报错。
- 热更程序集（`.bytes`）与 AOT 元数据要一起进包，缺一个会在运行时还原失败。

## 发布前核对

- [ ] `Asset Validator` 无 Error
- [ ] Addressables 分组已更新，冗余已清理
- [ ] Build Settings 场景列表完整
- [ ] 版本号已填（否则包内版本为空）
- [ ] HybridCLR 元数据与热更 DLL 同批生成
