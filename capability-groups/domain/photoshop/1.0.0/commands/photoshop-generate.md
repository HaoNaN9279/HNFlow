---
name: photoshop-generate
description: 生成常见操作的 Photoshop ExtendScript/UXP 代码模板：图层操作、批处理、UI 组件和 manifest 配置
model: standard
---

# `/photoshop-generate` — Photoshop 代码生成

生成常见操作的 Photoshop ExtendScript/UXP 代码模板。封装了来自方案.md 第 2.2 节的 Photoshop 命令调用。

## 用法

```
/photoshop-generate <类别> [选项]
```

别名：`/ps-generate`、`/ps-gen`

---

## 类别

### 1. 图层操作 (`layer` / `layer-op`)

生成 ExtendScript (.jsx) 图层操作代码。

**选项：**
- `--action`（必需）：逗号分隔的操作列表

**支持的操作和模板：**

#### `create`
```javascript
// @target photoshop
(function () {
    if (app.documents.length === 0) { alert("没有打开的文档。"); return; }
    var doc = app.activeDocument;
    var newLayer = doc.artLayers.add();
    newLayer.name = "New Layer";
    // 创建后设置属性
    newLayer.opacity = 100;
    newLayer.blendMode = BlendMode.NORMAL;
})();
```

#### `rename`
```javascript
(function () {
    if (app.documents.length === 0) return;
    var doc = app.activeDocument;
    if (doc.activeLayer) {
        doc.activeLayer.name = "RenamedLayer";
    }
})();
```

#### `delete`
```javascript
(function () {
    if (app.documents.length === 0) return;
    var doc = app.activeDocument;
    if (doc.activeLayer && !doc.activeLayer.isBackgroundLayer) {
        doc.activeLayer.remove();
    }
})();
```

#### `duplicate`
```javascript
(function () {
    if (app.documents.length === 0) return;
    var doc = app.activeDocument;
    var dupLayer = doc.activeLayer.duplicate();
    dupLayer.name = doc.activeLayer.name + " copy";
})();
```

#### `group`
```javascript
(function () {
    if (app.documents.length === 0) return;
    var doc = app.activeDocument;
    var layerSet = doc.layerSets.add();
    layerSet.name = "New Group";
    // 将活动图层移入组
    doc.activeLayer.move(layerSet, ElementPlacement.PLACEATEND);
})();
```

#### `merge`
```javascript
(function () {
    if (app.documents.length === 0) return;
    var doc = app.activeDocument;
    // 合并可见图层（等效于 Ctrl+Shift+E）
    doc.mergeVisibleLayers();
    // 或合并链接图层：doc.mergeLinkedLayers()
    // 或合并特定组：layerSet.merged()
})();
```

#### `rasterize`
```javascript
(function () {
    if (app.documents.length === 0) return;
    var doc = app.activeDocument;
    doc.activeLayer.rasterize(RasterizeType.ENTIRELAYER);
})();
```

---

### 2. 批处理 (`batch`)

生成用于跨文件夹批处理文件的 ExtendScript (.jsx)。

**选项：**
- `--input-folder`（必需）：源目录路径
- `--output-format`（必需）：目标格式——`jpg`、`png`、`tiff`、`psd`
- `--resize`（可选）：目标尺寸，例如 `1920x1080`

**模板：**

```javascript
// @target photoshop
(function () {
    if (app.documents.length > 0) { app.activeDocument.close(SaveOptions.DONOTSAVECHANGES); }

    var inputFolder = Folder("输入文件夹路径");
    var outputFolder = Folder("输出文件夹路径");
    if (!inputFolder.exists) { alert("输入文件夹未找到。"); return; }
    if (!outputFolder.exists) outputFolder.create();

    var fileList = inputFolder.getFiles(/\.(psd|tif|tiff|jpg|jpeg|png)$/i);
    for (var i = 0; i < fileList.length; i++) {
        var doc = app.open(fileList[i]);
        // --- 可选调整大小块 ---
        // if (doc.width > 1920) doc.resizeImage(UnitValue(1920, "px"));
        // --- 调整大小结束 ---
        var saveFile = new File(outputFolder + "/" + doc.name.replace(/\.\w+$/, ".目标扩展名"));
        var saveOpts = getSaveOptions("目标扩展名");
        doc.saveAs(saveFile, saveOpts, true, Extension.LOWERCASE);
        doc.close(SaveOptions.DONOTSAVECHANGES);
    }

    function getSaveOptions(ext) {
        ext = ext.toLowerCase();
        if (ext === "jpg" || ext === "jpeg") {
            var opts = new JPEGSaveOptions();
            opts.quality = 12;
            opts.embedColorProfile = true;
            opts.formatOptions = FormatOptions.STANDARDBASELINE;
            return opts;
        }
        if (ext === "png") {
            var opts = new PNGSaveOptions();
            opts.compression = 6;
            opts.interlaced = false;
            return opts;
        }
        if (ext === "tiff" || ext === "tif") {
            var opts = new TiffSaveOptions();
            opts.compression = TIFFEncoding.TIFFLZW;
            opts.alphaChannels = true;
            opts.layers = false;
            opts.imageCompression = MethodType.LZW;
            return opts;
        }
        if (ext === "psd") {
            var opts = new PhotoshopSaveOptions();
            opts.alphaChannels = true;
            opts.layers = true;
            opts.spotColors = true;
            return opts;
        }
        return null;
    }
})();
```

**格式转换说明：**

| 输出格式 | SaveOptions 类 | 关键属性 |
|---------------|-----------------------|----------------------------------------------|
| JPEG | `JPEGSaveOptions` | `quality` (0–12), `embedColorProfile`, `matte` |
| PNG | `PNGSaveOptions` | `compression` (0–6), `interlaced` |
| TIFF | `TiffSaveOptions` | `compression` (LZW/JPEG/ZIP/None), `layers` |
| PSD | `PhotoshopSaveOptions` | `alphaChannels`, `layers`, `spotColors` |

---

### 3. UXP UI 组件 (`uxp-ui`)

生成用于面板插件的 UXP (.psjs + HTML) UI 组件存根。

**选项：**
- `--component`（必需）：逗号分隔列表——`button`、`slider`、`color-picker`、`dropdown`、`checkbox`、`text-input`

**通用 UXP UI 结构：**

```html
<!-- index.html — 面板入口点 -->
<!DOCTYPE html>
<html>
<head>
<script src="main.psjs"></script>
<style>
  body { font-family: sans-serif; padding: 12px; }
  /* 使用 Spectrum Web Components 设计令牌以获得 Adobe 原生外观：
     https://opensource.adobe.com/spectrum-css/ */
</style>
</head>
<body>
  <!-- 组件在此注入 -->
</body>
</html>
```

```javascript
// main.psjs — 面板逻辑入口
"use strict";
const app = require('photoshop').app;
const core = require('photoshop').core;
```

**组件存根：**

#### Button
```javascript
// HTML：<button id="myBtn">运行操作</button>
// .psjs：
document.getElementById("myBtn").addEventListener("click", async function () {
    await core.executeAsModal(async () => {
        const doc = app.activeDocument;
        if (!doc) { app.showAlert("没有打开的文档。"); return; }
        // ... 操作 ...
    });
});
```

#### Slider
```javascript
// HTML：
// <label for="opacitySlider">不透明度：<span id="opacityVal">100</span>%</label>
// <input type="range" id="opacitySlider" min="0" max="100" value="100">
// .psjs：
document.getElementById("opacitySlider").addEventListener("input", function (e) {
    document.getElementById("opacityVal").textContent = e.target.value;
});
document.getElementById("applyOpacity").addEventListener("click", async function () {
    var val = parseInt(document.getElementById("opacitySlider").value, 10);
    await core.executeAsModal(async () => {
        if (app.activeDocument) app.activeDocument.activeLayer.opacity = val;
    });
});
```

#### Color Picker
```javascript
// HTML：<input type="color" id="colorPicker" value="#ff0000">
// .psjs：
document.getElementById("colorPicker").addEventListener("input", function (e) {
    var hex = e.target.value; // "#ff0000"
    // 将十六进制转换为 RGB 供 Photoshop API 使用
    var r = parseInt(hex.slice(1,3), 16);
    var g = parseInt(hex.slice(3,5), 16);
    var b = parseInt(hex.slice(5,7), 16);
    // 配合 batchPlay() 设置前景色
    // 参考：require('photoshop').action
});
```

#### Dropdown
```javascript
// HTML：
// <select id="blendModeSelect">
//   <option value="normal">正常</option>
//   <option value="multiply">正片叠底</option>
//   <option value="screen">滤色</option>
// </select>
// .psjs：
document.getElementById("blendModeSelect").addEventListener("change", async function (e) {
    var mode = e.target.value;
    await core.executeAsModal(async () => {
        if (app.activeDocument) {
            // BlendMode 枚举通过 app.blendModes 或 batchPlay 访问
            // ExtendScript：var blendEnum = eval("BlendMode." + mode.toUpperCase());
        }
    });
});
```

#### Checkbox
```javascript
// HTML：
// <label><input type="checkbox" id="visibleCheck" checked> 保持可见</label>
// .psjs：
document.getElementById("visibleCheck").addEventListener("change", function (e) {
    var isChecked = e.target.checked;
    // 在后续操作中使用该值
});
```

#### Text Input
```javascript
// HTML：
// <label>图层名称：<input type="text" id="layerNameInput" value="新图层"></label>
// .psjs：
document.getElementById("applyNameBtn").addEventListener("click", async function () {
    var name = document.getElementById("layerNameInput").value;
    if (!name) { app.showAlert("名称不能为空。"); return; }
    await core.executeAsModal(async () => {
        if (app.activeDocument) app.activeDocument.activeLayer.name = name;
    });
});
```

---

### 4. manifest.json 生成 (`manifest`)

生成 v4、v5 或 v6 的 UXP `manifest.json` 文件。

**选项：**
- `--version`（必需）：manifest 版本——`4`、`5` 或 `6`
- `--host-min`（必需）：最低 Photoshop 版本，例如 `24.0`
- `--permissions`（可选）：逗号分隔的 UXP 权限

**模板：**

#### v4 (PS 2022–2023, `apiVersion: 2`)
```json
{
    "manifestVersion": 4,
    "id": "com.example.myplugin",
    "version": "1.0.0",
    "name": "My Plugin",
    "entrypoints": [
        {
            "type": "command",
            "id": "run",
            "label": "运行我的插件"
        }
    ],
    "host": [
        {
            "app": "PS",
            "minVersion": "23.0.0"
        }
    ]
}
```

#### v5 (PS 2023+ — 新增 `requiredPermissions`)
```json
{
    "manifestVersion": 5,
    "id": "com.example.myplugin",
    "version": "1.0.0",
    "name": "My Plugin",
    "entrypoints": [
        {
            "type": "panel",
            "id": "mainPanel",
            "label": "我的插件",
            "icons": [
                { "width": 23, "height": 23, "path": "icons/dark.png" },
                { "width": 46, "height": 46, "path": "icons/dark@2x.png" }
            ]
        }
    ],
    "host": [
        {
            "app": "PS",
            "minVersion": "24.0.0"
        }
    ],
    "requiredPermissions": {
        "localFileSystem": "readWrite",
        "network": "disabled",
        "creativeCloud": "disabled"
    }
}
```

#### v6 (PS 2024+ — 增强的权限模型)
```json
{
    "manifestVersion": 6,
    "id": "com.example.myplugin",
    "version": "1.0.0",
    "name": "My Plugin",
    "entrypoints": [
        {
            "type": "panel",
            "id": "mainPanel",
            "label": "我的插件",
            "icons": [
                { "width": 23, "height": 23, "path": "icons/dark.png" },
                { "width": 46, "height": 46, "path": "icons/dark@2x.png" }
            ]
        }
    ],
    "host": [
        {
            "app": "PS",
            "minVersion": "25.0.0"
        }
    ],
    "requiredPermissions": {
        "localFileSystem": "readWrite",
        "network": "disabled",
        "creativeCloud": "disabled",
        "clipboard": "readWrite",
        "openWithDefaultApp": "enabled"
    },
    "features": {
        "webview": "enabled"
    }
}
```

**权限参考：**

| 权限 | 值 | 描述 |
|-------------------------|---------------------------|--------------------------------------|
| `localFileSystem` | `none`、`read`、`readWrite` | 文件打开/保存对话框、文件夹访问 |
| `network` | `none`、`enabled`、`disabled` | HTTP/HTTPS 请求 |
| `creativeCloud` | `none`、`enabled`、`disabled` | CC 库访问 |
| `clipboard` | `none`、`readWrite` | 系统剪贴板 (v6+) |
| `openWithDefaultApp` | `none`、`enabled` | 在 OS 默认应用中打开文件 (v6+) |

---

### 5. `.atn` 到 ExtendScript 转换 (`atn` / `action-to-script`)

生成将 Photoshop Action (.atn) 文件转换为 ExtendScript (.jsx) 的指导。

**选项：**
- `--input`（必需）：`.atn` 文件路径

**重要说明：`.atn` 是二进制格式**——此命令不直接解析 `.atn` 文件。而是提供推荐的工作流程和代码脚手架。

**转换工作流程：**

1. **在 Photoshop 中加载动作** — 文件 > 打开或双击 `.atn`
2. **打开动作面板**（窗口 > 动作）
3. **选择动作**并点击面板菜单 > **"回放设置..."**
4. **使用 Scripting Listener 插件录制为脚本**（Adobe 的官方日志插件）：
   - 从 Adobe 开发者资源安装 Scripting Listener
   - 通过 Photoshop 菜单启用：Plugins > Scripting Listener > Enable Logging
   - 播放一次动作——监听器将 JavaScript 等效项输出到 ESTK Console
5. **提取输出**并包裹在 ExtendScript 函数中：

```javascript
// @target photoshop
(function () {
    // 在此粘贴监听器输出——通常是带描述符对象的
    // 一系列 executeAction() 调用。
    // 示例结构（非真实动作）：
    try {
        var desc = new ActionDescriptor();
        var ref = new ActionReference();
        ref.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
        desc.putReference(charIDToTypeID("null"), ref);
        executeAction(charIDToTypeID("Mk  "), desc, DialogModes.NO);
    } catch (e) {
        alert("动作步骤失败：" + e.toString());
    }
})();
```

**关键转换模式：**

| 动作面板步骤 | ExtendScript 等效项 |
|-------------------------|------------------------------------------------|
| 新建图层 | `app.activeDocument.artLayers.add()` |
| 设置前景色 | `app.foregroundColor.rgb = [R, G, B]` |
| 填充选区 | `app.activeDocument.selection.fill(fillColor)` |
| 应用滤镜 | `app.activeDocument.activeLayer.applyFilter()` |
| 保存文档 | `app.activeDocument.saveAs()` / `save()` |
| 关闭文档 | `app.activeDocument.close(SaveOptions.xxxxx)` |
| 按名称选择图层 | `app.activeDocument.layers.getByName("name")` |
| 调整图像大小 | `app.activeDocument.resizeImage()` |

**自动 .atn 解析的局限性：**
- `.atn` 存储序列化的 `PIActionDescriptor` 数据——它是一种专有二进制格式，没有公开的公共 schema
- 动作步骤可以包含条件逻辑（if/else 分支），这些不会暴露给 Scripting Listener
- 包含多个子动作的动作集需要手动消歧
- 某些动作步骤（例如模态对话框）不会产生监听器输出——这些需要手动实现
- 动作名称中的字符编码在不同 Photoshop 版本之间有所不同

> **建议**：对于复杂动作，使用 Scripting Listener 逐个录制每个步骤，而不是尝试批量转换。对于简单的线性动作，从监听器日志手动转录是可靠的。

---

## 版本映射

| 生成类别 | ExtendScript | UXP (.psjs) | 说明 |
|-------------------------|:---:|:---:|------------------------------------|
| 图层操作 | ✓ | ✓ | UXP 需要 `executeAsModal` 包装器 |
| 批处理 | ✓ | — | 使用 ExtendScript 进行无头批处理 |
| UXP UI 组件 | — | ✓ | 需要 HTML 面板结构 |
| Manifest 生成 | — | ✓ | JSON 配置，无运行时代码 |
| .atn 转换指导 | ✓ | — | 仅工作流程指导 |

---

## 参考

- Adobe Photoshop JavaScript Reference (ExtendScript DOM)
- Adobe UXP Developer Guide (manifest 版本、权限)
- Photoshop Scripting Listener 插件（Adobe 开发者下载）
- 方案.md 第 2.2 节 — 代码生成架构
