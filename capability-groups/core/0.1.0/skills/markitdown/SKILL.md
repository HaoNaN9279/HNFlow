---
name: markitdown
description: 当用户需要将 PDF、Word、Excel、PPT、HTML、图片、音频等文件转换为 Markdown 格式时使用。支持 CLI 和 Python API 两种调用方式，通过 uv 管理虚拟环境。
license: MIT
---

# MarkItDown — 文档转 Markdown 工具

Microsoft MarkItDown 是一个轻量级 Python 工具，将各种文件格式转换为 Markdown，用于 LLM 和文本分析管线。

支持的文件格式：PDF、PowerPoint、Word、Excel、图片（EXIF/OCR）、音频、HTML、CSV/JSON/XML、ZIP、YouTube 链接、EPub 等。

## 工具入口

工具代码位于 `tools/markitdown/0.1.6/`，统一通过 `hnflow-stack` 调用。首次运行自动执行 `uv sync`。

```bash
hnflow-stack tool run markitdown --help
```

## 核心工作流

### 1. CLI 方式（推荐快速转换）

```bash
hnflow-stack tool run markitdown path/to/file.pdf

# 转换并保存到文件
hnflow-stack tool run markitdown path/to/file.pdf -o output.md

# 从 stdin 读取
cat path/to/file.pdf | hnflow-stack tool run markitdown
```

### 2. Python API 方式

```python
# 在 hnflow_stack_ROOT/tools/markitdown 目录下
from markitdown import MarkItDown

md = MarkItDown()
result = md.convert("path/to/file.xlsx")
print(result.text_content)
```

### 3. 使用 LLM 进行图片描述

```python
from openai import OpenAI
from markitdown import MarkItDown

client = OpenAI()
md = MarkItDown(llm_client=client, llm_model="gpt-4o")
result = md.convert("example.jpg")
print(result.text_content)
```

## 参数说明

- **`enable_plugins`**: 是否启用第三方插件（默认 `False`）
- **`llm_client`**: OpenAI 兼容客户端，用于图片描述
- **`llm_model`**: 模型名称（如 `"gpt-4o"`）

### CLI 选项

| 选项 | 说明 |
|------|------|
| `-o FILE` | 输出到文件 |
| `-x EXT` | 提示文件扩展名 |
| `-m MIME` | 提示 MIME 类型 |
| `-p` / `--use-plugins` | 启用第三方插件 |

## 注意事项

- **路径**: 使用 `hnflow-stack tool run markitdown`，不要写死仓库路径
- **安全**: 优先使用 `convert_local()` 或 `convert_stream()` 处理不受信任的输入
- **依赖**: 首次运行自动执行 `uv sync`
