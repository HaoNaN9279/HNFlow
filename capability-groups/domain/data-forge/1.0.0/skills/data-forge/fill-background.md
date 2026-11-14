---
name: fill-background
description: 给带透明通道的图片填充指定颜色背景，始终输出 RGB
---

# Fill-Background — 图片背景填充

使用 DataForge 的 `fill_background` 模块为带透明通道（RGBA）的图片填充指定十六进制颜色背景，输出为不含透明通道的 RGB 图片。支持单张和批量两种模式。

## 路径规则

**所有文件路径参数必须使用绝对路径**（`--input`、`--output`、`--input-dir`、`--output-dir`），禁止使用相对路径。原因：AI 代理的当前工作目录不确定，相对路径会导致文件找不到或写入错误位置。示例中使用 `/path/to/` 作为占位符，实际使用时替换为真实绝对路径。

## CLI 调用

```bash
# 单张处理
uv run --project <工具路径> \
  python -m data_forge.tools.fill_background single \
  --input <源图片绝对路径> \
  --output <输出图片绝对路径> \
  [--background-color "#FFFFFF"]

# 批量处理
uv run --project <工具路径> \
  python -m data_forge.tools.fill_background batch \
  --input-dir <源目录绝对路径> \
  --output-dir <输出目录绝对路径> \
  [--background-color "#FFFFFF"] \
  [--overwrite]
```

## 参数说明

| 参数 | 模式 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `--input` | single | 是 | — | 源图片文件路径（**必须使用绝对路径**） |
| `--output` | single | 是 | — | 输出图片文件路径（**必须使用绝对路径**） |
| `--input-dir` | batch | 是 | — | 源图片目录，处理目录下所有支持的图片（**必须使用绝对路径**） |
| `--output-dir` | batch | 是 | — | 输出目录，处理后的图片写入此目录（**必须使用绝对路径**） |
| `--background-color` | 通用 | 否 | `#FFFFFF` | 填充颜色的十六进制值，格式如 `#FFFFFF`、`#0000FF` |
| `--overwrite` | batch | 否 | `false` | 覆盖已存在的输出文件。默认跳过已有文件 |

## 使用示例

### 1. 基本用法：PNG 透明背景 → 白色背景 JPEG

将带透明通道的 PNG logo 转换为白色背景的 JPEG：

```bash
uv run --project <工具路径> \
  python -m data_forge.tools.fill_background single \
  --input /path/to/logo.png \
  --output /path/to/logo.jpg
```

### 2. 自定义颜色：RGBA 图片 → 绿色背景

```bash
uv run --project <工具路径> \
  python -m data_forge.tools.fill_background single \
  --input /path/to/overlay.png \
  --output /path/to/overlay_green.jpg \
  --background-color "#00FF00"
```

### 3. 批量处理整个目录

将 `/path/to/assets/` 下所有带透明通道的图片批量填充白色背景，输出到 `/path/to/filled/`：

```bash
uv run --project <工具路径> \
  python -m data_forge.tools.fill_background batch \
  --input-dir /path/to/assets \
  --output-dir /path/to/filled \
  --background-color "#FFFFFF" \
  --overwrite
```

## 输出格式说明

- 输出始终为 RGB（不含透明通道），透明区域替换为指定的 `--background-color`。
- 输入图片若不含透明通道（如 JPEG），则不做任何修改直接输出。
