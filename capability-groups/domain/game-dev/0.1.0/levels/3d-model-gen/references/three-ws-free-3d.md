# three.ws 免费 3D 接口参考

面向 AI Agent 的免费 3D 生成/绑定/检索入口。所有事实以 three.ws 文档与 `tools/list` 为准；接口可能变化，调用前可重新拉取 schema。

## 免费 3D Studio MCP

- 端点：`https://three.ws/api/mcp-studio`
- 传输：Streamable HTTP，JSON-RPC 2.0，MCP `2025-06-18`
- 鉴权：无（免费、平台出资）
- 限制：4 次生成/分钟、30 次/小时/caller；传输层约 300 请求/分钟
- 可选 install token：`POST https://three.ws/api/mcp-studio/install`，连接 URL 加 `?install=<token>` 获得独立额度
- 失败/限流以 HTTP 200 的 JSON-RPC error 返回，带 `Retry-After`/`RateLimit-*`

列出工具：

```bash
curl -sS https://three.ws/api/mcp-studio \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 生成类工具（全部免费）

| 工具 | 参数 | 说明 |
|---|---|---|
| `forge_free` | `prompt` 3–1000，`tier` draft/standard/high（默认 standard），`idempotency_key`≤200 | 文生 3D 通用模型 |
| `text_to_avatar` | `prompt` 或 `image_url` | 生成角色头像/半身 |
| `mesh_forge` | `prompt` 或 `image_url` | 艺术指导 mesh |
| `rig_mesh` | `glb_url` | 给已有 mesh 绑定 |
| `forge_avatar` | `prompt` 或 `image_url`，可选 `allow_non_humanoid` | 直接生成绑定、可动画角色 |
| `refine_model` | `glb_url`，`instruction` 1–500，可选 `parent_prompt`/`reference_image_url`/`parent_lineage`/`parent_index` | 细化已有 GLB |

任务与资产：

- `get_job`：`job_id`，只查状态，不推进、不计生成额度。
- `check_job`：`job_id`（8–4096），可选 `refine`；领取 pending 结果并物化模型。
- `look_at_model`：`glb_url`，可选 `views`/`size`，渲染预览。
- `search_catalog`：`q`/`kind`/`category`/`tag`/`limit`/`offset`。
- `get_catalog_item`、`get_item_source`：读取 CC0 道具、绑定角色、动作片段。
- `search_docs`、persona 三件套：文档与人设，非资产生成。

## 响应

成功时 `result.structuredContent` 可能含：

```json
{
  "kind": "model",
  "glbUrl": "https://...",
  "viewerUrl": "https://...",
  "arUrl": "https://...",
  "format": "glb",
  "prompt": "...",
  "referenceImageUrl": "https://..."
}
```

另给 snake_case：`viewer_url`、`glb_url`、`poster_png_url`、`embed_html`；绑定角色额外 `irlUrl`。

排队：

```json
{
  "status": "pending",
  "jobId": "...",
  "pollUrl": "...",
  "viewer_url": "...",
  "stage": "reference",
  "etaRemainingSeconds": 30
}
```

## 免费 REST（无需 key）

- `POST https://three.ws/api/v1/ai/text-to-3d`：每 IP 10 次/天，`prompt` 3–1000；完成 `{data:{status:"done",glb_url,viewer_url,creation_id,backend:"nvidia",tier:"draft"}}`，排队 pending + `poll_url` `/api/forge?job=...`；轮询 `GET https://three.ws/api/forge?job=<job>`。
- `POST https://three.ws/api/3d/studio`、`GET /api/3d/studio?job=`：ChatGPT Actions 形状，完成 `{status:"done",glbUrl,viewerUrl,arUrl,format:"glb"}`。
- `POST https://three.ws/api/3d/generate`、`GET /api/3d/generate?job=`：text→draft GLB。
- `POST https://three.ws/api/3d/inspect`、`/api/3d/diff`：检查/比较。
- `POST /api/print/quote`、`/api/print/prepare`：打印报价与 STL/3MF/GLB 准备。
- `POST /api/render/glb`：PNG 渲染，64–2048，10 MB 限制。
- `POST /api/ar`：AR 链接/查看。

免费 REST 的 `tier` 是 `draft`，单主体、无绑定；需要绑定时用 MCP 的 `rig_mesh`/`forge_avatar`。

## 免费范围

本组只使用上文的免费 MCP 工具与免费 REST 端点；不调用任何需要付款、余额或订阅的接口。需要绑定、头像或细化时，用 MCP 的 `rig_mesh`、`forge_avatar`、`refine_model`。

## 最小调用

```bash
# 生成
curl -sS https://three.ws/api/mcp-studio \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"forge_free","arguments":{"prompt":"a stylized wooden treasure chest, iron bands, game prop, single object","tier":"standard","idempotency_key":"chest-001"}}}'

# 轮询
curl -sS https://three.ws/api/mcp-studio \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"check_job","arguments":{"job_id":"<jobId>"}}}'
```

拿到 `glbUrl` 后必须下载校验；不要把 `viewerUrl` 当最终交付。
