---
name: video-transcribe-full
description: 完整版视频转写技能。当用户给出视频链接或本地视频文件，需要下载/导入视频、提取音频、语音转写、翻译为简体中文、"先看画面再定位"截取关键画面并生成内嵌图片的 Markdown 文档时使用。画面质量优先，含视觉预采样与镜头对齐，耗时较长。
license: MIT
---

# Video Transcribe（完整版）— 视频转写 + 画面索引

从 YouTube、Vimeo 等主流视频网站下载视频，提取音频，用 Qwen3-ASR 转写，由 AI **先看画面再标记**，按时间窗口截取关键帧，生成内嵌图片的 Markdown 文档。

**核心原则：不要靠文字猜时间点，要先看到画面再定位。** 语音分段边界（ASR 按停顿断句）与视觉镜头边界（按操作节奏切换）并不重合，只读 transcript 必然截错、截漏。

## 模板

你是一个视频内容整理助手。用户给出视频链接后，你按下面的工作流把视频转成一份带中文译文和关键画面索引的 Markdown 笔记。

## 前置条件

- 工具通过 `hnflow-stack tool run video-transcribe ...` 调用，工具路径见规则文件 ``hnflow-stack tool list``。
- 首次使用前，在工具目录执行 `uv sync` 安装依赖（含 yt-dlp、qwen-asr、私有 ffmpeg）。
- **GPU**：语音转写默认使用本机 CUDA（`--device cuda`）。**若本机 CUDA 不可用，工具直接报错并停止**——告知用户并停止，不要改用 CPU 静默降级。
- **模型**：仅使用 `Qwen/Qwen3-ASR-0.6B` 与 `Qwen/Qwen3-ForcedAligner-0.6B`，存于工具目录 `models/`（不入版本管理）。`transcribe` 会自动检测，缺失时下载。

## 核心工作流

按顺序执行，其中第 2.5、3、6 步由你（AI）完成：

### 1. 获取视频（链接下载 或 本地文件导入）

```bash
# 视频链接：下载到 <输出根目录>/<标题>/
hnflow-stack tool run video-transcribe fetch "<视频URL>" --out "<输出根目录>"

# 本地视频文件：原地引用（不复制），job 目录以文件名命名
hnflow-stack tool run video-transcribe fetch "<本地视频文件路径>" --out "<输出根目录>"
```

`fetch` 会自动判断：参数是**已存在的文件**则按本地视频导入（视频留在原处，不被复制或删除）；否则按 URL 下载，视频保存为 job 目录内的 `<标题>.<ext>`。创建以标题（或文件名）命名的 job 目录 `<输出根目录>/<标题>/`。

### 2. 转写

```bash
hnflow-stack tool run video-transcribe transcribe "<job目录>" --context "<领域术语>"
```

- 输出 `transcript.json`（逐段时间戳）与 `transcript.txt`。
- `--language` 可强制语言；默认自动检测（建议省略，避免误判）。
- `--context` 传入专有名词 / 行业术语，帮助模型正确识别。

`transcript.json` 结构：

```json
{ "language": "English", "text": "完整原文",
  "segments": [{ "start": 12.3, "end": 15.7, "text": "……" }] }
```

> Qwen3-ASR 的 `text` 标点输出**不稳定**。第 3 步的**中文译文必须自行补齐标点**，译文即最终正文。

### 2.5 视觉预采样（probe + scenes）— 必做，否则第 3 步就是盲猜

让 AI **真正看到画面**：按固定间隔抽低分辨率缩略图，拼成带时间戳的 contact sheet；再检测镜头切换点。

```bash
hnflow-stack tool run video-transcribe probe "<job目录>" \
    --interval 3 --cols 5 --rows 4 --thumb-width 240 --max-samples 240
hnflow-stack tool run video-transcribe scenes "<job目录>"
```

- `probe` 产出 `probe/sheet_0001.png …`（网格图）与 `probe/index.json`（每格 → 时间戳、缩略图路径、sheet 位置、实际间隔）。
- `scenes` 产出 `scenes.json`：`{"threshold": 0.3, "scenes": [0.0, 12.3, 27.8, …]}`，即镜头切换时间列表。
- `--max-samples` 会在视频过长时自动放大实际间隔（写入 `index.json.interval`），避免产出过多缩略图。

**第 3 步开始前，你必须先用 Read 打开这些 contact sheet 图片，并结合 `probe/index.json` 的时间戳与 `scenes.json` 的镜头边界复现画面**——不允许只读 transcript 就下标记。

### 3. 翻译 + 逐段判断 + 标记截帧（由 AI 完成）

结合 `transcript.json` + contact sheet + `scenes.json`，产出 `marks.json`：

**(a) 中文译文 `translations`**：为**每一个** segment（按 `segments` 下标 `index`）提供简体中文译文。

- 忠实翻译；**专业术语、软件/节点名保留原语言**。
- 译文必须**标点完整、语句通顺**（同时修复原文本标点）。
- 覆盖全部 segment；缺失的段回退英文原文。

**(b) 逐段判断 `analysis`**：对每个 segment 输出可核对的结构化判断，而不是凭感觉：

```json
{ "index": 3, "need_frame": true, "reason": "讲到在 Transform 节点改 rotation，属具体操作+界面" }
```

**(c) 截帧标记 `marks`**：对 `need_frame=true` 的段给出**时间窗口**（不是单点）。工具会在窗口内自动挑选最具代表性的一帧（避开转场与运动模糊）。

```json
{
  "analysis": [{ "index": 3, "need_frame": true, "reason": "……" }],
  "marks": [
    { "start": 45.2, "end": 48.0, "alt": "Transform 参数面板", "note": "改 rotation 参数" }
  ],
  "translations": [{ "index": 0, "zh": "……" }]
}
```

- `marks[].start` / `marks[].end`（必填，单位秒）：画面稳定出现该内容的**时间窗口**。兼容旧写法 `time`（视为零宽窗口）。
- `marks[].alt`：替代文本；`marks[].note`（可选）：补充说明。
- `translations` 也接受 `{"0": "……"}` 映射形式；`analysis` 可省略（不影响工具执行）。

#### 何时需要标帧（满足任一即 `need_frame=true`）

- 具体**操作/步骤**：在哪个节点、连什么线、改哪个参数、点哪个按钮；
- 出现**界面元素**：节点网络、参数面板、spreadsheet、属性表、视图/视口；
- 出现**演示、示例、对比、可视化、图表、时间轴、几何体/效果展示**；
- 内容**依赖画面才能理解**：含「像这样」「这里」「你可以看到」「这个节点」等指示表述；
- 内容本身**就是视觉信息**（形状、颜色、布局、效果的呈现）。

#### 量化下限（硬性，替代「宁可多标」的空话）

- 涉及操作 / 界面 / 演示的 segment：**至少 1 帧**。
- 时长 > 8 秒且画面有变化的 segment：**至少 2 帧**。
- 同一节点网络的不同参数状态、前后对比：**分别截取**。

#### 定位时间窗口的规则

- **对齐镜头边界**：窗口应落在 `scenes.json` 给出的某个镜头内部，不要跨越两次切换。
- **取动作完成时刻**：窗口取「描述的画面已完整呈现」的那几秒，**不要取 segment 的起点**——起点常是上一句刚结束、画面仍在过渡/切换的瞬间。
- 拿不准就放宽窗口（1–4 秒），让工具去挑最稳的一帧。

#### 自检问题（写完每条 `analysis` 后逐条自答）

> 「如果读者只有这段文字，能否复现视频里的操作 / 看到效果？不能 → 必须标帧。」

### 4. 截取画面

```bash
hnflow-stack tool run video-transcribe capture "<job目录>"
```

- 对每个 mark，在 `[start, end]` 内用 `thumbnail` 过滤器挑**最具代表性的一帧**（零宽窗口则按单点截取）。
- 按时间顺序命名 `frames/frame_0001.png …`，写 `frames/manifest.json`。
- 额外生成回看用 `frames/contact_sheet_0001.png …`（`--no-sheet` 可关闭）。

### 5. 校验闭环（build 前必做）

`capture` 之后，**先用 Read 打开 `frames/contact_sheet_0001.png …` 回看已截的帧**：

- 逐张对照 `analysis` 的 `reason`，确认帧内容与文字描述一致；
- 发现**黑屏 / 过渡帧 / 错位 / 主体不在画面**，则回到 `marks.json` 修正该 mark 的 `start`/`end`（对齐镜头、后移到动作完成时刻），重新 `capture`；
- 确认无误后再执行第 6 步 `build`。

### 6. 生成 Markdown

```bash
hnflow-stack tool run video-transcribe build "<job目录>"
```

生成 `<标题>.md`：正文用中文译文（无译文段回退原文），每张图内嵌到对应文字段落后（`![](frames/...)`）。**同一段落的多帧按时间顺序依次内嵌**，信息密集段不再只有一张图。

- md 开头「来源」：视频链接则写链接；本地文件则写 `本地文件 \`<文件名>\``。

### 7. 清理（最后一步，必做）

```bash
hnflow-stack tool run video-transcribe clean "<job目录>"
```

只保留 `<标题>.md` 与 `frames/frame_*.png`，删除其余中间产物：视频文件、`audio/`、`transcript.*`、`scenes.json`、`probe/`、`marks.json`、`frames/manifest.json`、`frames/contact_sheet_*.png`、`job.json`。

- 若来源是**视频链接**，job 目录内的下载视频会被一并删除；
- 若来源是**本地文件**，源视频在 job 目录之外，`clean` 不会触碰它。

## 产物结构

处理中的完整结构：

```
<输出根目录>/<视频标题>/
    <视频标题>.mp4              ← 链接下载；本地导入则在源路径
    audio/<视频标题>.wav
    transcript.json / transcript.txt
    scenes.json                 ← 镜头边界
    probe/index.json            ← 缩略图 → 时间戳索引
    probe/sheet_0001.png        ← 视觉预采样 contact sheet
    probe/thumbs/thumb_00001.png
    marks.json                  ← AI 产出（analysis + marks 窗口 + translations）
    frames/manifest.json
    frames/frame_0001.png
    frames/contact_sheet_0001.png   ← 回看用
    <视频标题>.md
```

`clean` 之后的最终结构：

```
<输出根目录>/<视频标题>/
    <视频标题>.md
    frames/frame_0001.png …
```

## 模型管理

```bash
hnflow-stack tool run video-transcribe model status   # 检测模型
hnflow-stack tool run video-transcribe model ensure    # 下载缺失模型
```

## 参数速查

| 参数 | 说明 |
|------|------|
| `--interval` | probe 抽帧间隔秒数（默认 3） |
| `--cols` / `--rows` | contact sheet 网格（默认 5×4，共 20 帧/张） |
| `--thumb-width` | 缩略图宽度像素（默认 240） |
| `--max-samples` | 缩略图数量上限，超长视频自动放大间隔（默认 240） |
| `--threshold` | scenes 场景分数阈值（默认 0.3，越低越敏感） |
| `--no-sheet` | capture 时不生成回看 contact sheet |
| `--model-dir` | 模型目录（默认 `<工具>/models`，环境变量 `VIDEO_TRANSCRIBE_MODELS` 可覆盖） |
| `--device` | torch 设备，默认 `cuda` |
| `--language` | 强制语言；默认自动检测 |
| `--context` | 领域术语提示 |
| `--source` | 模型来源：`hf`（默认）/ `modelscope` |

## 常见错误

- **CUDA 不可用**：工具报错要求检查 GPU 环境。停止任务并告知用户，不降级到 CPU。
- **截图错位 / 截到过渡帧**：排查——(1) 第 2.5 步是否真的执行并**看过 contact sheet**？(2) 时间窗口是否覆盖「动作完成时刻」而非 segment 起点？(3) 窗口是否跨越了 `scenes.json` 的镜头边界（应落在单个镜头内）？修正后重跑 `capture`。
- **画面不完整 / 一屏塞不下**：信息密集段（同一节点改多个参数、前后对比）应拆成多个 mark，每段多帧。
- **marks.json 缺失/为空**：`capture` 报错，需先完成第 3 步。
- **段落显示为英文**：该 `index` 缺少译文，回到第 3 步补齐 `translations`。
- **本地文件被判成链接**：`fetch` 仅在参数指向**已存在的文件**时按本地导入；确认路径正确（可用绝对路径）。
- **ffmpeg 相关报错**：使用工具私有 ffmpeg（来自 `imageio-ffmpeg`），不依赖系统 PATH。

## 使用时机

用户给出**视频链接或本地视频文件**，或要求「下载视频并转写」「视频翻译成中文」「提取视频里的画面」「生成带截图的视频笔记」，且**更看重画面质量、可接受较长耗时**时，加载本技能。

若用户更看重速度、希望尽快出结果，改用 **`video-transcribe-fast`**（快速版）。
