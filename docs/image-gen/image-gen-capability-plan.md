# 图像生成能力组：`image-gen` 0.1.0

> 状态：已实现。组目录：`capability-groups/domain/image-gen/0.1.0/`。

## 1. 定位

`image-gen` 把“文字描述 → 图片”沉淀为可复用的能力：提示词设计、免费端点调用、下载校验和元数据交付。

它只负责**图像**；3D 生成、游戏资产 brief 在 `game-dev` 组。

## 2. 目录

```text
capability-groups/domain/image-gen/0.1.0/
  group.json
  rules/
    00-image-generation.md      # 免费边界、结果落盘、质量、内容边界
  skills/
    image-prompt/               # 视觉想法 → 结构化提示词/画幅/seed
    text-to-image/              # 调用、下载、校验、元数据
  references/
    pollinations-image-api.md   # 免费匿名接口契约、参数、错误、落盘字段
```

## 3. 接口

- 使用 Pollinations 的匿名免费端点：`GET https://image.pollinations.ai/prompt/{url-encoded-prompt}`。
- 无需 API key、账户或余额；不调用任何需要凭据或付款的接口。
- 参数：`width`、`height`、`seed`、`model`（常用 `flux`）、`nologo`。
- 响应是图片字节（通常是 `image/jpeg`），不是 JSON；相同 URL 可能命中共享缓存。实际输出尺寸以解码结果为准，端点可能把过小尺寸提升到最小值（实测请求 512×512 返回 768×768）。
- 幂等：同 prompt + 同宽高 + 同 seed 得到同一结果；需要新图时换 seed 或改 prompt。

## 4. 工作流

1. `image-prompt`：确认主体/构图/风格/画幅，产出 prompt、width、height、seed。
2. `text-to-image`：拼接并请求免费端点 → 下载 → 校验 → 写 `image.json`。
3. 交付：本地路径、预览、尺寸、prompt、seed、模型、来源 URL。

## 5. 激活与校验

```sh
hnflow-stack activate image-gen@0.1.0
hnflow-stack validate
hnflow-stack resolve --json --project <项目>
```

`game-dev/3d-model-gen` 通过 `extends: ["image-gen"]` 自动带入本组内容，不需要重复激活。

## 6. 失败与边界

- 401/402/403：免费通道暂时不可用，停止并报告，不改用其他通道。
- 400：修正 prompt/参数；429：按 `Retry-After` 退避，最多重试两次；5xx/超时：最多重试一次。
- 不把 URL 当最终交付；必须落本地文件并校验。
- 不生成违法、仇恨、侵权真人肖像或商标内容。
- 不承诺透明背景、精确文字排版、多图严格一致。
