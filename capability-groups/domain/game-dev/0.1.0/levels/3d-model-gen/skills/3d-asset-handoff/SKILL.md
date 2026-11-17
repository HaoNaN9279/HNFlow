---
name: 3d-asset-handoff
description: 当 3D 资产已生成或下载，需要校验 GLB、生成预览与元数据、按引擎无关规范整理并交接给游戏项目时使用。
---

# 3D 资产交接 — 校验、预览、元数据与导入验收

把生成结果变成“可以直接进项目”的资产包：GLB、预览、元数据、验收记录。不绑定具体引擎。

## 前置条件

- 已有 GLB 本地文件或可下载 URL。
- 已知资产用途、目标尺度、是否需要绑定/动画。
- 目标项目有 `assets/models/<slug>/` 目录。

## 核心工作流

### 1. 下载与完整性

- 下载到 `assets/models/<slug>/<slug>.glb`。
- 校验魔数 `glTF`、文件大小、`sha256`。
- 如果来源是 MCP，保留 `jobId`、工具名、tier、原始 prompt、`viewerUrl`。

### 2. 结构检查

优先用 three.ws：

```bash
curl -sS -X POST https://three.ws/api/3d/inspect \
  -H 'content-type: application/json' \
  -d "{\"glb_url\":\"$GLB_URL\"}"
```

记录：三角面数、顶点数、材质数、纹理数、包围盒、是否含骨骼/动画、是否有 UV。没有网络时用本地 glTF 工具（如 `gltf-transform inspect`）替代。

### 3. 预览

- 用 `look_at_model` 或 `/api/render/glb` 生成 PNG 预览；保存为 `<slug>-preview.png`。
- 检查轮廓、朝向、材质是否可读；有明显破面/缺纹理时先 `refine_model` 或重生成，不要直接交付。

### 4. 规范化

- 命名：`<slug>.glb`、`<slug>-preview.png`、`<slug>.json`。
- 尺度：确认 1 单位 = 1 米；包围盒符合 brief。不符合时记录并在引擎导入时缩放，不直接改未授权资产。
- 朝向：记录前向轴/上轴；引擎无关约定写进元数据，导入时再转换。
- 枢轴：记录原点位置（脚底/几何中心/自定义）。
- 碰撞：单独说明建议碰撞体，不用渲染网格代替。
- LOD：如有，命名 `<slug>_lod0/1/2`。

### 5. 写元数据

`assets/models/<slug>/asset.json`：

```json
{
  "slug": "supply-crate",
  "type": "prop",
  "source": "three.ws-mcp-studio",
  "tool": "forge_free",
  "tier": "standard",
  "prompt": "...",
  "files": {"glb": "supply-crate.glb", "preview": "supply-crate-preview.png"},
  "bounds_m": {"x": 1.2, "y": 1.0, "z": 0.8},
  "triangles": 4200,
  "materials": 2,
  "textures": 3,
  "rigged": false,
  "animations": [],
  "forward_axis": "+Z",
  "up_axis": "+Y",
  "pivot": "base-center",
  "collision": "box",
  "license": "three.ws generated / 按平台条款",
  "sha256": "...",
  "notes": "木纹在背面略糊，可接受"
}
```

### 6. 引擎无关导入验收

逐项确认：

- [ ] GLB 能被目标引擎/查看器打开，无报错。
- [ ] 尺度与 brief 一致（米制）。
- [ ] 朝向与枢轴符合项目约定，或已记录转换方式。
- [ ] 材质/纹理完整，目标渲染管线下颜色正确。
- [ ] 面数/纹理在预算内。
- [ ] 绑定资产有骨骼与至少一个可播放动画；命名可读。
- [ ] 碰撞体建议已给出（盒/凸包/网格）。
- [ ] 预览图、元数据、来源与许可证齐全。
- [ ] 资产清单中的用途/优先级已回填。

### 7. 交接

输出一段可粘贴的交接摘要：

```text
资产：supply-crate
文件：assets/models/supply-crate/supply-crate.glb
预览：assets/models/supply-crate/supply-crate-preview.png
规格：1.2×1.0×0.8 m，4200 tris，2 材质，未绑定
用途：P0 场景可交互物
遗留：背面纹理略糊；碰撞建议 box
```

## 常见错误

- **只交 viewer URL**：链接会过期；必须落本地 GLB。
- **不校验魔数**：把 HTML 错误页当 GLB 导入。
- **忽略尺度**：引擎里变成巨人或蚂蚁。
- **不记录枢轴/朝向**：每次导入都要猜。
- **绑定资产没验动画**：引擎里 T-pose 不动。
- **元数据缺来源**：后续无法追溯许可证与生成参数。

## 使用时机

3D 生成完成、收到外包 GLB、或需要把资产从生成目录搬进游戏项目时使用；生成本身用 `free-3d-generation`。
