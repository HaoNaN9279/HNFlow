---
name: convert
description: 在 PNG、JPG、WebP、BMP 格式之间转换图片，支持单张和批量模式
---

# Convert — 图片格式转换

通过 DataForge 的 `convert` 模块在 PNG、JPG、JPEG、WebP、BMP 格式之间转换图片，支持单张和批量两种模式。

## 路径规则

**所有文件路径参数必须使用绝对路径**（`--input`、`--output`、`--input-dir`、`--output-dir`），禁止使用相对路径。原因：AI 代理的当前工作目录不确定，相对路径会导致文件找不到或写入错误位置。示例中使用 `/path/to/` 作为占位符，实际使用时替换为真实绝对路径。

## CLI 调用

```bash
# 单张转换（格式由输出文件扩展名自动识别）
uv run --project <工具路径> \
  python -m data_forge.tools.convert single \
  --input <源图片绝对路径> \
  --output <目标图片绝对路径> \
  [--background-color <背景色>]

# 批量转换（需指定 --output-format）
uv run --project <工具路径> \
  python -m data_forge.tools.convert batch \
  --input-dir <源目录绝对路径> \
  --output-dir <输出目录绝对路径> \
  --output-format <目标格式> \
  [--background-color <背景色>] \
  [--overwrite]
```

## 参数说明

| 参数 | 模式 | 必填 | 说明 |
|------|------|------|------|
| `--input` | single | 是 | 源图片文件路径（**必须使用绝对路径**） |
| `--output` | single | 是 | 输出图片文件路径，格式由扩展名自动识别（**必须使用绝对路径**） |
| `--input-dir` | batch | 是 | 源图片目录，转换目录下所有支持的图片（**必须使用绝对路径**） |
| `--output-dir` | batch | 是 | 输出目录，所有转换后的图片写入此目录（**必须使用绝对路径**） |
| `--output-format` | batch | 是 | 目标格式：`png`、`jpg`、`jpeg`、`webp`、`bmp` |
| `--background-color` | 通用 | 否 | RGBA → RGB 转换时填充透明通道的十六进制背景色，默认 `#FFFFFF` |
| `--overwrite` | batch | 否 | 覆盖已存在的输出文件。默认跳过已有文件 |

## 支持格式

- `png` — Portable Network Graphics
- `jpg` / `jpeg` — JPEG
- `webp` — WebP
- `bmp` — BMP

## 模式区别

| | 单张模式 (single) | 批量模式 (batch) |
|---|---|---|
| 触发条件 | 使用 `--input` / `--output` | 使用 `--input-dir` / `--output-dir` |
| 目标格式 | 由 `--output` 文件扩展名自动识别 | 由 `--output-format` 显式指定 |
| 输入 | 单个文件 | 整个目录（所有支持的格式） |
| 输出 | 单个文件 | 整个目录，文件名保留原名、扩展名替换为目标格式 |

## 示例

### 1. 单张转换：PNG → JPEG

将带透明通道的 PNG logo 转换为白色背景的 JPEG：

```bash
uv run --project <工具路径> \
  python -m data_forge.tools.convert single \
  --input /path/to/logo.png \
  --output /path/to/logo.jpg \
  --background-color "#FFFFFF"
```

### 2. 单张转换：JPEG → WebP

```bash
uv run --project <工具路径> \
  python -m data_forge.tools.convert single \
  --input /path/to/photo.jpg \
  --output /path/to/photo.webp
```

### 3. 批量转换：整个目录转 WebP

将 `/path/to/raw_photos/` 下所有图片转换为 WebP 格式，输出到 `/path/to/webp_output/`：

```bash
uv run --project <工具路径> \
  python -m data_forge.tools.convert batch \
  --input-dir /path/to/raw_photos \
  --output-dir /path/to/webp_output \
  --output-format webp
```

### 4. 批量转换：带透明通道填充

将 `/path/to/assets/` 下所有 PNG 转换为 JPG，透明区域填充蓝色：

```bash
uv run --project <工具路径> \
  python -m data_forge.tools.convert batch \
  --input-dir /path/to/assets \
  --output-dir /path/to/jpg_output \
  --output-format jpg \
  --background-color "#0000FF"
```
