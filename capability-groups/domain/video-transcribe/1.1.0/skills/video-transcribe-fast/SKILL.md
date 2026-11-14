---
name: video-transcribe-fast
description: 快速版视频转写技能。当用户给出视频链接或本地视频文件，需要下载/导入视频、提取音频、语音转写、翻译为简体中文、截取关键画面并生成内嵌图片的 Markdown 文档，且更看重速度时使用。跳过耗时的全片视觉预采样与镜头检测，以「转写→单点截帧→回看修正」流程快速产出可接受的结果。
license: MIT
---

# Video Transcribe（快速版）— 视频转写 + 关键帧

完整版 `video-transcribe-full` 的轻量替代：**跳过最耗时的两步**（`probe` 全片抽缩略图、`scenes` 全片镜头检测，二者都要解码整段视频），改用「按 transcript 选点 → 单点截帧 → 回看 contact sheet 修正」的流程，快速产出**较为可接受**的 Markdown 笔记。

何时用本技能：视频较长 / 不太在意每帧都完美 / 只想尽快拿到中文笔记。
何时改用完整版：画面质量优先、需要精确对齐镜头与动作完成时刻。

## 前置条件

- 工具：`hnflow-stack tool run video-transcribe ...`，工具路径见 ``hnflow-stack tool list``。首次使用先在工具目录 `uv sync`。
- **GPU**：转写默认 `--device cuda`；CUDA 不可用则工具报错停止，**不要降级到 CPU**。
- **模型**：`Qwen/Qwen3-ASR-0.6B` 与 `Qwen/Qwen3-ForcedAligner-0.6B`，存于工具目录 `models/`，`transcribe` 自动按需下载。

## 核心工作流

### 1. 获取视频（链接下载 或 本地文件导入）

```bash
# 视频链接
hnflow-stack tool run video-transcribe fetch "<视频URL>" --out "<输出根目录>"
# 本地视频文件（原地引用，不复制）
hnflow-stack tool run video-transcribe fetch "<本地视频文件路径>" --out "<输出根目录>"
```

参数是已存在的文件则按本地导入，否则按 URL 下载。job 目录以标题（或文件名）命名。

### 2. 转写

```bash
hnflow-stack tool run video-transcribe transcribe "<job目录>" --context "<领域术语>"
```

产出 `transcript.json`（逐段时间戳）与 `transcript.txt`。

### 3. 翻译 + 选点（由 AI 完成）

读 `transcript.json`，写 `marks.json`：为**每个** segment 提供中文译文（`translations`），并为需要画面的段选**单点时间** `time`。

**选点规则（本技能不做视觉预采样，靠下面的规则 + 第 4 步回看兜底）：**

- 涉及操作 / 界面 / 演示的 segment：**至少 1 帧**。
- 时间取**中后段（约 segment 的 60%–80%）**，让画面稳定下来——**不要取 segment 起点**（常是上一句刚结束、画面仍在过渡的瞬间）。
- 时长 > 8 秒且明显有变化的段，可给 2 个 `time`。
- 拿不准就标上（多一张图比漏一张好）。

```json
{
  "marks": [
    { "time": 45.2, "alt": "Transform 参数面板", "note": "改 rotation 参数" }
  ],
  "translations": [{ "index": 0, "zh": "……（标点完整）" }]
}
```

- `marks[].time`（必填，秒）：**单点**截帧时刻。若某帧经回看确认不准，可把它改成 `{"start": .., "end": ..}` 让工具在窗口内挑最佳帧（完整版同款能力）。
- `translations` 也接受 `{"0": "……"}` 映射；译文缺标点不影响（译文即正文）。

### 4. 截帧 + 回看修正（关键的一步，不可省）

```bash
hnflow-stack tool run video-transcribe capture "<job目录>"
```

按 `marks.json` 单点截帧到 `frames/frame_0001.png …`，并生成回看用 `frames/contact_sheet_0001.png …`。

**随后必须用 Read 打开 contact sheet 回看**：

- 有**黑屏 / 明显过渡帧 / 主体不在画面**的，回到 `marks.json` 调后该点的 `time`（或改成短窗口），再 `capture` 一次；
- 无明显问题的，直接进入下一步。通常一轮修正即可。

### 5. 生成 Markdown

```bash
hnflow-stack tool run video-transcribe build "<job目录>"
```

生成 `<标题>.md`：正文用中文译文，图片内嵌到对应段落后。

- md 开头「来源」：视频链接则写链接；本地文件则写 `本地文件 \`<文件名>\``。

### 6. 清理（最后一步，必做）

```bash
hnflow-stack tool run video-transcribe clean "<job目录>"
```

只保留 `<标题>.md` 与 `frames/frame_*.png`，删除视频、`audio/`、`transcript.*`、`marks.json`、`frames/manifest.json`、`frames/contact_sheet_*.png`、`job.json` 等中间产物。链接来源的下载视频会被删除；本地来源的源文件在 job 之外，不受影响。

## 产物结构

处理中：`<job>/<标题>.mp4(或本地源)、audio/、transcript.*、marks.json、frames/frame_*.png、frames/contact_sheet_*.png、<标题>.md`

`clean` 后：`<job>/<标题>.md` + `<job>/frames/frame_*.png`

## 与完整版的差异

| 项 | 快速版 | 完整版 |
|----|--------|--------|
| 全片 `probe` 视觉预采样 | 跳过 | 执行（耗时长） |
| `scenes` 镜头检测 | 跳过 | 执行（耗时长） |
| marks | 单点 `time` | `start`/`end` 时间窗口 |
| 画面质量保障 | transcript 规则 + 一轮回看修正 | 先看画面定位 + 量化下限 + 回看 |
| 相对耗时 | 低 | 高 |

## 常见错误

- **CUDA 不可用**：停止任务并告知用户，不降级 CPU。
- **截图错位**：把该 mark 的 `time` 后移，或改用短 `start`/`end` 窗口后重跑 `capture`。
- **段落显示为英文**：该 `index` 缺译文，补齐 `translations`。
- **`capture` 报错 marks.json 缺失**：先完成第 3 步。
- **本地文件被判成链接**：`fetch` 仅在参数指向已存在文件时按本地导入，确认路径正确。

## 使用时机

用户给出**视频链接或本地文件**并要求「视频转写 / 翻译成中文 / 生成带截图的视频笔记」，且**更看重速度**时使用。若要求高质量画面，改用 `video-transcribe-full`。
