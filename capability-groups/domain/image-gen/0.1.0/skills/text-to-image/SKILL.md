---
name: text-to-image
description: 当用户需要根据文字描述生成图片、游戏概念图、角色/道具参考图或宣传图时使用；负责调用 Pollinations 免费图像端点、下载校验并交付本地文件与元数据。
---

# 文生图 — 从文字描述到可交付图像

把一句视觉需求变成可追溯的本地图像资产。只用免费、无需密钥的 Pollinations 图像 URL 端点，不调用任何计费接口。

## 前置条件

- 可访问 `https://image.pollinations.ai`。
- 项目内可写目录 `assets/images/<slug>/`。
- 可用 `curl` 或等价 HTTP 客户端；下载后能用图像库/查看器校验。
- 不需要 API key；不要向用户索要 key 或余额。

## 端点

```text
GET https://image.pollinations.ai/prompt/{url-encoded-prompt}
```

查询参数：

| 参数 | 说明 |
|---|---|
| `width` | 宽，默认 1024；常用 1024/1280/768 |
| `height` | 高，默认 1024；按画幅设定 |
| `seed` | 整数；相同种子便于复现，换种子出变体 |
| `model` | 可选；默认免费模型即可，常用 `flux` |
| `nologo` | 设为 `true` 去掉平台角标 |

响应是图片字节（通常是 `image/jpeg`），不是 JSON。相同 URL 可能命中共享缓存，返回 `X-Cache: HIT`。实际输出尺寸以解码结果为准：端点可能把过小的宽高提升到最小值（实测请求 512×512 返回 768×768），交付时必须读取真实宽高。

## 核心工作流

### 1. 锁定需求

向用户确认或从上下文提取：

- 主体、动作、环境、构图、镜头（特写/全身/俯视等）。
- 风格、年代、材质、光线、色调。
- 用途与画幅：游戏概念图通常 16:9；角色设定图可 3:4 或 9:16；图标 1:1。
- 是否需要多张变体、是否固定 seed 做系列一致性。

缺信息时只问真正影响结果的一两项，其余按 brief 合理默认并在交付时说明。

### 2. 写提示词

使用同组 `image-prompt` 技能的结构化模板；把最终 prompt、宽高、seed 写进命令或临时 JSON，避免 shell 转义破坏引号。

- 提示词用英文描述具体视觉事实，避免只堆 `masterpiece, 8k`。
- 单主体更稳；需要多个对象时明确数量与关系。
- 不要在提示词里要求生成可读文字或 Logo；需要时后期排版。

### 3. URL 编码

对 prompt 做百分号编码（空格→`%20`，逗号、斜杠等也编码），不要把原始中文或未编码空格直接拼进 URL。示例使用 `curl --get --data-urlencode`，由 curl 负责编码。

### 4. 先出一张

```bash
mkdir -p "assets/images/$SLUG"
curl -L --fail --silent --show-error --max-time 120 \
  --get "https://image.pollinations.ai/prompt/$(python -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$PROMPT")" \
  --data-urlencode "width=$WIDTH" \
  --data-urlencode "height=$HEIGHT" \
  --data-urlencode "seed=$SEED" \
  --data-urlencode "model=flux" \
  --data-urlencode "nologo=true" \
  -o "assets/images/$SLUG/$SLUG-$SEED.jpg"
```

更稳妥的做法：用 Python/Node 的 URL 编码函数拼完整 URL，再交给 `curl -L --fail`；不要依赖 shell 手工替换。

- 每次逻辑生成用不同的 seed 或不同 prompt；完全相同的 URL 会命中缓存。
- 不要并发发多张；先验证方向。

### 5. 下载并校验

```bash
curl -L --fail --silent --show-error "$IMAGE_URL" -o "assets/images/$SLUG/$SLUG-$STAMP.jpg"
```

校验：

- HTTP 状态 200；`Content-Type` 以 `image/` 开头。
- 文件大小 > 10 KB，扩展名与 Content-Type 一致（`image/jpeg`、`image/png`、`image/webp`）。
- 用 `file`、ImageMagick `identify`、Pillow 或系统查看器确认能解码并读取宽高。
- 记录 `sha256`，避免重复资产。

### 6. 写元数据

在图片旁写 `image.json`（`width`/`height` 写解码后的实际值，不是请求值）：

```json
{
  "slug": "robot-mascot",
  "prompt": "...",
  "width": 1280,
  "height": 720,
  "seed": 12345,
  "model": "flux",
  "tool": "pollinations-image-url",
  "source_url": "https://image.pollinations.ai/prompt/...",
  "downloaded_at": "2026-11-15T13:30:00+08:00",
  "sha256": "...",
  "bytes": 123456
}
```

### 7. 交付

向用户给出：

- 本地绝对/相对路径与预览。
- 实际尺寸、提示词、seed、模型。
- 与需求不符的地方和下一步建议（改 prompt、换 seed、批量变体）。

## 错误处理

| 状态 | 含义 | 处理 |
|---|---|---|
| 400 | prompt 为空或参数不合法 | 修正后重试一次 |
| 401/402/403 | 免费通道要求凭据或余额 | 停止；不索要 key、不充值、不改用其他通道 |
| 429 | 限流 | 按 `Retry-After` 等待，最多重试两次，仍失败则报告 |
| 5xx/超时 | 上游故障 | 等待 5–10 秒重试一次；仍失败则报告 |
| 响应不是图片 | 端点返回错误页/JSON | 保存状态码与响应摘要，停止并报告 |
| 缓存命中但内容不符 | 同 URL 旧结果 | 换 seed 或改 prompt 后重新请求 |

## 边界

- 只走免费匿名端点；不调用任何计费 API、不提交付款信息。
- 不生成违法、仇恨、侵权真人肖像或商标内容。
- 不承诺透明背景、精确文字排版、多图严格一致；这些需要后期或专门工具。
