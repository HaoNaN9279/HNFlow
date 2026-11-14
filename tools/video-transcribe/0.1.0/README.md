# video-transcribe

从视频网站下载视频，提取音频，用 Qwen3-ASR 转写为带时间戳的文字，按 AI 标记截取关键画面，并生成内嵌图片的 Markdown 文档。

## 安装

```bash
uv sync                 # 安装 yt-dlp、qwen-asr、私有 ffmpeg 等
```

模型（仅 0.6B）首次使用时按需下载到 `models/`（不入版本管理）。

## 命令

```bash
# 1. 下载视频，创建以标题命名的 job 目录
uv run video-transcribe fetch "<URL>" --out "<输出根目录>"

# 2. 提取音频 + ASR 转写（默认 CUDA，缺失模型自动下载）
uv run video-transcribe transcribe "<job目录>" --language Chinese --context "术语 词汇"

# 3.（AI 阅读 transcript.json，写 marks.json：中文译文 + 关键画面标记）

# 4. 按 marks.json 截取关键画面
uv run video-transcribe capture "<job目录>"

# 5. 生成内嵌图片的 Markdown（正文用中文译文）
uv run video-transcribe build "<job目录>"

# 模型管理
uv run video-transcribe model status
uv run video-transcribe model ensure --source modelscope
```

## marks.json（AI 产出）

```json
{
  "marks": [
    { "time": 123.4, "alt": "节点编辑器界面", "note": "演示连接材质节点" }
  ],
  "translations": [
    { "index": 0, "zh": "Point Deform 很多人拿它做各种变形……" }
  ]
}
```

- `marks`：需查看屏幕的时间点。`time` 秒；`alt` 图片说明；`note` 可选。
- `translations`：每个 transcript 段（`index`）的简体中文译文；专业术语保留原语言。译文自带标点，同时修复 Qwen3-ASR 偶发的标点缺失。缺译文的段回退显示原文。

## 设计要点

- **FFmpeg 私有化**：使用 `imageio-ffmpeg` 随包提供的二进制，不读取、不修改系统 `PATH` 或环境变量。
- **GPU**：默认 `--device cuda`。本机 CUDA 不可用时直接报错停止，不做 CPU 静默降级。
- **模型**：只下载 `Qwen/Qwen3-ASR-0.6B` 与 `Qwen/Qwen3-ForcedAligner-0.6B`。
- **代理**：默认 `http://oversea.blackjack-local.com:1086`，可用 `--proxy` 或 `HTTPS_PROXY` 覆盖。

## 产物结构

```
<输出根目录>/<标题>/
    job.json
    <标题>.mp4
    audio/<标题>.wav
    transcript.json
    transcript.txt
    marks.json
    frames/manifest.json
    frames/frame_0001.png
    <标题>.md
```

## 测试

```bash
uv run pytest
```
