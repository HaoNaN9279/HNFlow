# Resize — 批量图片缩放

使用 `data_forge.tools.resize` 模块批量缩放图片，支持精确尺寸缩放、长边适配和填充模式。

## 路径规则

**所有文件路径参数必须使用绝对路径**（`--input-dir`、`--output-dir`），禁止使用相对路径。原因：AI 代理的当前工作目录不确定，相对路径会导致文件找不到或写入错误位置。示例中使用 `/path/to/` 作为占位符，实际使用时替换为真实绝对路径。

## CLI 调用

```bash
hnflow-stack tool exec data-forge python -m data_forge.tools.resize \
    --input-dir <源目录绝对路径> \
    --output-dir <输出目录绝对路径> \
    --width <宽度> \
    --height <高度> \
    [--fit-long-edge] \
    [--pad-to-fit] \
    [--overwrite]
```

**路径说明：**
- `<工具路径>` 为 工具绝对路径（见 ``hnflow-stack tool list``）

## 参数说明

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `--input-dir` | `str` | 是 | — | 源图片目录路径（**必须使用绝对路径**） |
| `--output-dir` | `str` | 是 | — | 输出目录路径（**必须使用绝对路径**） |
| `--width` | `int` | 是 | — | 目标宽度（像素） |
| `--height` | `int` | 是 | — | 目标高度（像素） |
| `--fit-long-edge` | `bool` | 否 | `false` | 等比缩放，使长边适配 `max(width, height)`，保持原始宽高比。例如 1600×900 的图片使用 `--width 800 --height 600`，长边宽度 1600 缩放到 800，高度按比例缩放到 450。与 `--pad-to-fit` 互斥 |
| `--pad-to-fit` | `bool` | 否 | `false` | 等比缩放图片以适应目标尺寸，然后将剩余区域用白色填充，输出精确的 `width × height`。与 `--fit-long-edge` 互斥，同时设置时 `--pad-to-fit` 优先 |
| `--overwrite` | `bool` | 否 | `false` | 覆盖已存在的输出文件。默认跳过已有文件 |

## 使用示例

### 示例 1：精确缩放

将 `/path/to/photos/` 目录下所有图片精确缩放至 1024×1024 像素：

```bash
hnflow-stack tool exec data-forge python -m data_forge.tools.resize \
    --input-dir /path/to/photos \
    --output-dir /path/to/resized \
    --width 1024 \
    --height 1024
```

### 示例 2：长边适配 + 填充 + 覆盖

将图片长边适配至 1024×1024 范围内，并用白色填充至精确尺寸，同时覆盖已有输出文件：

```bash
hnflow-stack tool exec data-forge python -m data_forge.tools.resize \
    --input-dir /path/to/photos \
    --output-dir /path/to/resized \
    --width 1024 \
    --height 1024 \
    --fit-long-edge \
    --pad-to-fit \
    --overwrite
```

## 说明

- **后端**：基于 Pillow（PIL）`LANCZOS` 重采样
- **批量处理**：仅支持目录批量模式，不支持单文件处理
- **支持的格式**：AVIF、BMP、GIF、ICO、JFIF、JPEG、JPG、PJP、PJPEG、PNG、TIF、TIFF、WebP
- **自动跳过**：非图片文件自动忽略；输出目录自动创建
- **格式兼容**：RGBA 图片输出为 JPEG 时自动填充白色背景
