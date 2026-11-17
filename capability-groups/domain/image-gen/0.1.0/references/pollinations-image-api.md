# Pollinations 免费图像接口参考

本文只记录本组使用的免费匿名文生图端点。不要把它扩展到需要 API key、余额或账户的接口。

## 端点

```text
GET https://image.pollinations.ai/prompt/{url-encoded-prompt}
```

- 认证：无。匿名请求直接返回图片字节。
- 计费：无。不要提交 API key、账户余额或付款信息。
- 响应：`200 OK` + `Content-Type: image/jpeg`（也可能是 `image/png`/`image/webp`）；响应头可含 `X-Cache: HIT|MISS`、`X-Auth-Status: unauthenticated`、`Content-Disposition`。

## 查询参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `width` | 否 | 宽，默认 1024；常用 1024、1280、768 |
| `height` | 否 | 高，默认 1024 |
| `seed` | 否 | 整数；相同 seed 便于复现，换 seed 出变体 |
| `model` | 否 | 免费模型名；常用 `flux` |
| `nologo` | 否 | `true` 去掉平台角标 |

自定义尺寸建议不超过 1536×1536，避免超时或降质。实际输出尺寸可能被端点调整（实测请求 512×512 返回 768×768），以解码后的宽高为准。

## 最小调用

```bash
curl -L --fail --silent --show-error --max-time 120 \
  --get "https://image.pollinations.ai/prompt/$(python -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$PROMPT")" \
  --data-urlencode "width=1280" \
  --data-urlencode "height=720" \
  --data-urlencode "seed=42" \
  --data-urlencode "model=flux" \
  --data-urlencode "nologo=true" \
  -o "assets/images/robot-mascot/robot-mascot-42.jpg"
```

注意：用脚本做 URL 编码，不要手工把空格、逗号、斜杠拼进路径。

## 缓存与幂等

- 相同 prompt、宽高、seed 的 URL 会命中共享缓存，返回 `X-Cache: HIT` 和同一张图。
- 没有 `Idempotency-Key` 机制；幂等靠“固定 URL + 固定 seed”，重跑前先检查本地是否已有同名 sidecar。
- 需要新图时换 `seed` 或改 prompt。

## 错误处理

| 状态 | 含义 | 处理 |
|---|---|---|
| 400 | prompt 为空或参数不合法 | 修正后重试一次 |
| 401/402/403 | 端点要求凭据/余额 | 停止；不要索要 key、充值或改用其他接口 |
| 429 | 限流 | 按 `Retry-After` 等待，最多重试两次 |
| 5xx/超时 | 上游故障 | 等待 5–10 秒重试一次 |
| 200 但非图片 | 返回错误页/JSON | 保存状态码与响应摘要，停止 |

## 结果落盘

- 图片与 `image.json` 放在同一目录。
- `image.json` 至少包含：`slug`、`prompt`、`width`、`height`、`seed`、`model`、`tool`、`source_url`、`downloaded_at`、`sha256`、`bytes`。
- 不要把 URL 当作最终交付；URL 只是可再请求的来源，缓存也可能失效。
