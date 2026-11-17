---
name: free-3d-generation
description: 当需要根据文字或参考图免费生成 3D 模型、角色、绑定资产、细化模型，或搜索现成 CC0 3D 资产时使用。
---

# 免费 3D 生成 — three.ws MCP Studio

通过 three.ws 的免费 3D Studio MCP 生成、绑定、细化或检索 3D 资产，并落成本地 GLB 与可追溯元数据。该 MCP 无需账号、密钥或付款，但有调用频率限制。

## 前置条件

- 已有一份资产 brief（同层或来自 `game-asset-brief`）：主体、风格、尺度、是否绑定、是否需要动画。
- 目标目录 `assets/models/<slug>/` 可写。
- 可用 `curl`；本地能校验 GLB（`file`/十六进制头/three.ws inspect）。
- 用户已知这是**免费、平台出资**的额度：4 次/分钟、30 次/小时/caller，不保证 SLA。
- 需要参考图时，先通过依赖组 `image-gen` 的 `text-to-image` 生成；该步骤使用免费 Pollinations 端点，不产生费用。

## 工具选择

| 需求 | 工具 | 关键参数 |
|---|---|---|
| 纯文字→通用模型/道具 | `forge_free` | `prompt`，`tier` 默认 `standard` |
| 文字或图片→角色头像/半身 | `text_to_avatar` | `prompt` 或 `image_url` |
| 文字或图片→艺术化 mesh | `mesh_forge` | `prompt` 或 `image_url` |
| 已有 GLB→绑定 | `rig_mesh` | `glb_url` |
| 文字或图片→已绑定、可动画角色 | `forge_avatar` | `prompt` 或 `image_url`，可选 `allow_non_humanoid` |
| 已有 GLB→按指令细化 | `refine_model` | `glb_url`、`instruction` |
| 现成资产优先 | `search_catalog` 等 | 先搜再生成 |

`tier`：`draft` 快、精度低；`standard` 默认、带纹理、稳定；`high` 质量更高但可能被平台降级。不要默认用 `high`。

## 核心工作流

### 0. 先搜现成资产

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_catalog","arguments":{"q":"crate","kind":"prop","limit":10}}}
```

有合适的 CC0 资产就下载并记录来源与许可证，不重复生成。catalog 读取不计生成额度。

### 1. 初始化 MCP 会话

端点：`https://three.ws/api/mcp-studio`（Streamable HTTP，JSON-RPC 2.0，MCP 2025-06-18，无鉴权）。

先 `initialize`，再 `notifications/initialized`，然后 `tools/call`：

```bash
curl -sS https://three.ws/api/mcp-studio \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"hnflow-3d","version":"0.1.0"}}}'
```

如果宿主是流式响应，按 SSE 读取 `data:` 行；普通 JSON 响应直接解析 `result`。

### 2. 生成

```bash
curl -sS https://three.ws/api/mcp-studio \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"forge_free","arguments":{"prompt":"a weathered wooden supply crate, metal corner brackets, game prop, single object","tier":"standard","idempotency_key":"crate-001"}}}'
```

- 一个资产一个 `idempotency_key`（≤200 字符，24 小时内同 key 复用结果）；重试沿用，换资产换 key。
- 需要图片引导时，把 `image-gen` 产出的本地图上传到可访问 URL，或使用 `image_url` 参数；不要把本地路径直接传给服务。

### 3. 解析与轮询

成功时 `result.structuredContent` 含 `kind`、`glbUrl`、`viewerUrl`、`arUrl`、`format:"glb"`、`referenceImageUrl` 等；排队时含 `status:"pending"`、`jobId`、`pollUrl`、`stage`、`etaRemainingSeconds`。

轮询：

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"check_job","arguments":{"job_id":"<jobId>"}}}
```

每 5–10 秒一次，最多约 5 分钟；`check_job` 首次会物化模型，不要重复生成。`get_job` 只查状态，不推进/不计生成额度，可用于轻量查询。

### 4. 下载

```bash
mkdir -p "assets/models/$SLUG"
curl -L --fail --silent --show-error "$GLB_URL" -o "assets/models/$SLUG/$SLUG.glb"
```

校验：

- 文件头前 4 字节为 `glTF`（二进制 GLB）。
- 文件大小合理（通常几十 KB 到几十 MB），非 HTML 错误页。
- 调 `POST https://three.ws/api/3d/inspect` 或 `look_at_model` 获取结构统计/预览图。
- 记录 `sha256` 和字节数。

### 5. 元数据

写 `assets/models/<slug>/asset.json`：

```json
{
  "slug": "supply-crate",
  "tool": "forge_free",
  "tier": "standard",
  "prompt": "...",
  "glb": "supply-crate.glb",
  "source_url": "https://...",
  "viewer_url": "https://...",
  "reference_image": "https://...",
  "sha256": "...",
  "generated_at": "2026-11-15T13:40:00+08:00",
  "license": "three.ws generated / 按平台条款",
  "rigged": false
}
```

绑定资产额外记录 `irlUrl`、骨架/动画片段（若响应提供）。

### 6. 交付

给出本地路径、预览、工具与 tier、多边形/尺寸（inspect 结果）、是否绑定、已知缺陷、下一步（refine/手工修/重生成）。详细交接用同层 `3d-asset-handoff`。

## 错误处理

- **JSON-RPC error + HTTP 200**：生成失败/限流会以 JSON-RPC error 返回；读 `error.message` 与 `Retry-After`/`RateLimit-*` 头。
- **429 / 限流**：等待后重试；不要并发轰炸；30 次/小时是硬预算。
- **pending 超时**：保留 `jobId`，用 `get_job` 查；仍失败则报告，不重复提交新生成。
- **下载到 HTML**：URL 过期或错误；重新 `check_job` 取新链接。
- **GLB 头不对**：视为失败，不要交给引擎。
- **免费额度不适合**：需要更高精度/商业 SLA 时，说明当前免费额度限制，建议拆件、简化 brief 或改天重试；不要引入其他通道。

## 边界

- 本层只走免费 MCP；不要尝试 REST 绑定接口或任何需要凭据/付款的接口。
- 不生成受版权保护的已知角色、商标或真人肖像。
- 不承诺拓扑、UV、骨骼命名完全符合某个引擎；交付前用 `3d-asset-handoff` 验收。
- 不把 `viewerUrl` 当作最终资产；必须下载 GLB。
