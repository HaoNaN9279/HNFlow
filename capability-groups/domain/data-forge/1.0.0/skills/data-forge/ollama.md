# Ollama — 本地模型推理 CLI 参考

通过 DataForge 的 Ollama 工具，在命令行中直接与本地 Ollama 服务交互，支持文本生成、视觉模型图片描述、模型管理和批量处理。

## 路径规则

**所有文件路径参数必须使用绝对路径**（`--image`、`--input-dir`、`--output-dir`），禁止使用相对路径。原因：AI 代理的当前工作目录不确定，相对路径会导致文件找不到或写入错误位置。示例中使用 `/path/to/` 作为占位符，实际使用时替换为真实绝对路径。

## 前置条件

- **Ollama 服务正在运行**：确保已安装并启动 Ollama（`ollama serve`）
- **Ollama 服务地址**：默认为 `http://localhost:11434`，可通过 `--base-url` 覆盖
- **Python 环境**：使用 `uv` 管理虚拟环境
- **已拉取所需模型**：可通过 `list` 查看现有模型，或使用 `pull` 下载新模型

## CLI 调用方式

```bash
hnflow-stack tool exec data-forge python -m data_forge.tools.ollama <subcommand> [参数...]
```

`<工具路径>` 为 工具绝对路径（见 ``hnflow-stack tool list``），例如：

```bash
hnflow-stack tool exec data-forge python -m data_forge.tools.ollama list
```

### 全局参数

以下参数可应用于所有子命令：

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--base-url` | `string` | `http://localhost:11434` | Ollama 服务地址 |
| `--timeout` | `int` | `300` | HTTP 请求超时秒数 |

---

## 子命令参考

### 1. `list` — 列出已安装模型

列出当前 Ollama 服务中所有可用模型及其元数据。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--base-url` | `string` | 否 | Ollama 服务地址 |
| `--timeout` | `int` | 否 | 请求超时秒数 |

**示例：**

```bash
# 列出所有模型
hnflow-stack tool exec data-forge python -m data_forge.tools.ollama list

# 指定自定义地址
hnflow-stack tool exec data-forge python -m data_forge.tools.ollama list --base-url http://192.168.1.100:11434
```

---

### 2. `pull` — 拉取模型

从 Ollama 镜像仓库下载模型到本地。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--name` | `string` | 是 | 模型名称（如 `llama3.2`、`gemma3:12b`） |
| `--base-url` | `string` | 否 | Ollama 服务地址 |
| `--timeout` | `int` | 否 | 请求超时秒数 |

**示例：**

```bash
# 拉取 llama3.2 模型
hnflow-stack tool exec data-forge python -m data_forge.tools.ollama pull --name llama3.2

# 拉取指定标签的模型
hnflow-stack tool exec data-forge python -m data_forge.tools.ollama pull --name gemma3:12b
```

---

### 3. `generate` — 文本生成

向指定模型发送提示词，生成文本回复。

**参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `--model` | `string` | 是 | — | 模型名称（如 `llama3.2`、`gemma3:12b`） |
| `--prompt` | `string` | 是 | — | 输入提示词 |
| `--system` | `string` | 否 | — | 系统提示词（设置模型行为） |
| `--temperature` | `float` | 否 | `0.7` | 采样温度（0.0–2.0），越高越有创造性 |
| `--base-url` | `string` | 否 | `http://localhost:11434` | Ollama 服务地址 |
| `--timeout` | `int` | 否 | `300` | 请求超时秒数 |

**示例：**

```bash
# 基本文本生成
hnflow-stack tool exec data-forge python -m data_forge.tools.ollama generate \
  --model llama3.2 \
  --prompt "用一句话解释什么是机器学习"

# 带系统提示词的生成
hnflow-stack tool exec data-forge python -m data_forge.tools.ollama generate \
  --model llama3.2 \
  --system "你是一位专业的 Python 开发者" \
  --prompt "写一个计算斐波那契数列的递归函数"

# 调整采样温度
hnflow-stack tool exec data-forge python -m data_forge.tools.ollama generate \
  --model llama3.2 \
  --prompt "写一首关于秋天的短诗" \
  --temperature 0.9
```

---

### 4. `describe` — 视觉描述

使用视觉模型（如 `llava`）描述图片内容。

**参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `--model` | `string` | 是 | — | 视觉模型名称（如 `llava`、`minicpm-v`、`bakllava`） |
| `--image` | `string` | 是 | — | 图片路径（**必须使用绝对路径**） |
| `--prompt` | `string` | 否 | `Describe this image in detail.` | 对图片的提问或指令 |
| `--base-url` | `string` | 否 | `http://localhost:11434` | Ollama 服务地址 |
| `--timeout` | `int` | 否 | `300` | 请求超时秒数 |

**示例：**

```bash
# 默认提示描述图片
hnflow-stack tool exec data-forge python -m data_forge.tools.ollama describe \
  --model llava \
  --image /path/to/photo.jpg

# 自定义提问
hnflow-stack tool exec data-forge python -m data_forge.tools.ollama describe \
  --model llava \
  --image /path/to/screenshot.png \
  --prompt "这张截图中的主要按钮有哪些？"

# 使用其他视觉模型
hnflow-stack tool exec data-forge python -m data_forge.tools.ollama describe \
  --model minicpm-v \
  --image /path/to/chart.png \
  --prompt "描述这张图表的内容"
```

---

### 5. `batch-generate` — 批量文本生成

将一个目录中的多个 `.txt` 文件作为提示词分别输入模型，结果保存到输出目录。

**参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `--model` | `string` | 是 | — | 模型名称 |
| `--input-dir` | `string` | 是 | — | 输入目录，含 `.txt` 提示词文件（**必须使用绝对路径**） |
| `--output-dir` | `string` | 是 | — | 输出目录，生成的结果文件（**必须使用绝对路径**） |
| `--system` | `string` | 否 | — | 系统提示词（应用于所有输入） |
| `--temperature` | `float` | 否 | `0.7` | 采样温度 |
| `--base-url` | `string` | 否 | `http://localhost:11434` | Ollama 服务地址 |
| `--timeout` | `int` | 否 | `300` | 请求超时秒数 |

**输出说明：** 每个输入文件生成一个结果文件，命名为 `result_N.txt`（N 从 0 开始计数）。

**示例：**

```bash
# 批量处理 /path/to/prompts/ 目录下所有 .txt 文件
hnflow-stack tool exec data-forge python -m data_forge.tools.ollama batch-generate \
  --model llama3.2 \
  --input-dir /path/to/prompts \
  --output-dir /path/to/results

# 批量生成带系统提示词
hnflow-stack tool exec data-forge python -m data_forge.tools.ollama batch-generate \
  --model llama3.2 \
  --input-dir /path/to/prompts \
  --output-dir /path/to/results \
  --system "用中文回答" \
  --temperature 0.5
```

---

### 6. `batch-describe` — 批量视觉描述

将一个目录中的多张图片（支持 `.jpg`、`.png`、`.webp` 等常见格式）分别送入视觉模型，生成每张图片的文字描述。

**参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `--model` | `string` | 是 | — | 视觉模型名称（如 `llava`） |
| `--input-dir` | `string` | 是 | — | 输入目录，含图片文件（**必须使用绝对路径**） |
| `--output-dir` | `string` | 是 | — | 输出目录，生成的描述文件（**必须使用绝对路径**） |
| `--prompt` | `string` | 否 | `Describe this image in detail.` | 对每张图片的提问 |
| `--base-url` | `string` | 否 | `http://localhost:11434` | Ollama 服务地址 |
| `--timeout` | `int` | 否 | `300` | 请求超时秒数 |

**支持的图片格式：** `.avif`、`.bmp`、`.gif`、`.ico`、`.jfif`、`.jpeg`、`.jpg`、`.pjp`、`.pjpeg`、`.png`、`.tif`、`.tiff`、`.webp`

**输出说明：** 每张图片生成一个同名 `.txt` 文件（例如 `photo.jpg` → `photo.txt`）。若输出目录中已存在同名描述文件，则跳过该图片。

**示例：**

```bash
# 批量描述 /path/to/images/ 目录下的所有图片
hnflow-stack tool exec data-forge python -m data_forge.tools.ollama batch-describe \
  --model llava \
  --input-dir /path/to/images \
  --output-dir /path/to/captions

# 自定义提示词
hnflow-stack tool exec data-forge python -m data_forge.tools.ollama batch-describe \
  --model llava \
  --input-dir /path/to/screenshots \
  --output-dir /path/to/descriptions \
  --prompt "详细描述这张图片中的物体和场景"
```

---

## 错误处理

### 连接失败

当 Ollama 服务未运行或地址不可达时，会返回类似以下错误：

```
Error: Cannot connect to Ollama server at http://localhost:11434.
Make sure Ollama is running (`ollama serve`) and the URL is correct.
```

**排查步骤：**

1. 确认 Ollama 服务已启动：`ollama serve`
2. 测试服务连通性：`curl http://localhost:11434/api/tags`
3. 检查 `--base-url` 是否正确（默认 `http://localhost:11434`）
4. 如果使用 Docker，确认端口已映射

### 模型未找到

当指定的模型不存在时（例如未执行 `pull`），Ollama 会返回 404 错误。请先使用 `pull` 子命令下载所需模型。

### 图片路径无效

对于 `describe` 和 `batch-describe`，确保 `--image` 或 `--input-dir` 路径指向实际存在的文件或目录。

### 超时

对于长文本生成或大批量处理，可以通过 `--timeout` 增加超时时间（默认 300 秒）。
