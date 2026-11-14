# LLM — 云端 LLM 文本生成与图片描述 CLI 参考

通过 OpenAI 兼容 API 调用云端大语言模型，支持文本生成、图片描述、批量处理和提供商管理。

## 路径规则

**所有文件路径参数必须使用绝对路径**（`--image`、`--input-dir`、`--output-dir`、`--keyfile`），禁止使用相对路径。原因：AI 代理的当前工作目录不确定，相对路径会导致文件找不到或写入错误位置。示例中使用 `/path/to/` 作为占位符，实际使用时替换为真实绝对路径。

## CLI 调用方式

```bash
hnflow-stack tool exec data-forge python -m data_forge.tools.llm <subcommand> [参数]
```

- `<工具路径>`：工具绝对路径（见 ``hnflow-stack tool list``）（包含 `pyproject.toml` 的目录）
- `<subcommand>`：要执行的操作（`chat`、`describe`、`batch-chat`、`batch-describe`、`list-providers`）

## 前置条件：KEYFILE

所有子命令（除 `list-providers` 外）都需要一个 JSON 格式的密钥文件，包含各提供商的 API 密钥和端点地址。

可通过 `--keyfile` 标志指定路径，或通过 `KEYFILE` 环境变量设置。

### KEYFILE 格式示例

```json
{
  "openai": {
    "api_key": "sk-proj-xxxxxxxxxxxxxxxx",
    "base_url": "https://api.openai.com/v1"
  },
  "deepseek": {
    "api_key": "sk-xxxxxxxxxxxxxxxx",
    "base_url": "https://api.deepseek.com"
  }
}
```

每个提供商条目必须包含：
| 字段 | 类型 | 说明 |
|------|------|------|
| `api_key` | string | API 密钥（必填） |
| `base_url` | string | API 端点地址（可选，默认为 `https://api.openai.com/v1`） |

## 支持的提供商

任何兼容 OpenAI API 格式的提供商均可使用，包括但不限于：

| 提供商 | base_url |
|--------|----------|
| OpenAI | `https://api.openai.com/v1` |
| DeepSeek | `https://api.deepseek.com` |
| Groq | `https://api.groq.com/openai/v1` |
| Together | `https://api.together.xyz/v1` |
| vLLM | 自托管（取决于部署地址） |
| Ollama | `http://localhost:11434/v1` |

## 子命令参考

### `chat` — 单轮文本生成

向指定的 LLM 提供商发送提示词，返回生成的文本回复。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--provider` | string | ✅ | 提供商名称（需在 KEYFILE 中定义，如 `openai`、`deepseek`） |
| `--model` | string | ✅ | 模型名称（如 `gpt-4o`、`deepseek-chat`） |
| `--prompt` | string | ✅ | 用户提示词 |
| `--keyfile` | string | ❌ | KEYFILE 路径，**必须使用绝对路径**（默认使用 `KEYFILE` 环境变量） |
| `--system` | string | ❌ | 系统消息 |
| `--temperature` | number | ❌ | 采样温度（0.0–2.0，默认 `0.7`） |
| `--max-tokens` | number | ❌ | 最大生成 token 数 |

**使用示例：**

```bash
hnflow-stack tool exec data-forge python -m data_forge.tools.llm chat \
  --provider openai \
  --model gpt-4o \
  --prompt "用一句话解释什么是机器学习" \
  --system "你是一个简洁的 AI 助手" \
  --temperature 0.5 \
  --max-tokens 200 \
  --keyfile /path/to/keys.json
```

### `describe` — 图片描述

向支持视觉能力的 LLM 模型发送图片，返回图片的描述文字。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--provider` | string | ✅ | 提供商名称 |
| `--model` | string | ✅ | 视觉模型名称（如 `gpt-4o`、`claude-3-5-sonnet`） |
| `--image` | string | ✅ | 图片文件路径（**必须使用绝对路径**） |
| `--keyfile` | string | ❌ | KEYFILE 路径 |
| `--prompt` | string | ❌ | 描述指令（默认 `Describe this image in detail.`） |
| `--temperature` | number | ❌ | 采样温度（默认 `0.7`） |
| `--max-tokens` | number | ❌ | 最大生成 token 数 |

**使用示例：**

```bash
hnflow-stack tool exec data-forge python -m data_forge.tools.llm describe \
  --provider openai \
  --model gpt-4o \
  --image /path/to/photo.jpg \
  --prompt "请详细描述这张图片的内容和构图" \
  --keyfile /path/to/keys.json
```

### `batch-chat` — 批量文本生成

从指定目录读取多个 `.txt` 提示词文件，逐一调用 LLM 生成回复，结果保存在输出目录中。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--provider` | string | ✅ | 提供商名称 |
| `--model` | string | ✅ | 模型名称 |
| `--input-dir` | string | ✅ | 输入目录，包含 prompt `.txt` 文件（**必须使用绝对路径**） |
| `--output-dir` | string | ✅ | 输出目录，生成文件保存位置（**必须使用绝对路径**） |
| `--keyfile` | string | ❌ | KEYFILE 路径（**必须使用绝对路径**） |
| `--system` | string | ❌ | 系统消息（应用于所有提示词） |
| `--temperature` | number | ❌ | 采样温度（默认 `0.7`） |
| `--max-tokens` | number | ❌ | 最大生成 token 数 |

**使用示例：**

```bash
hnflow-stack tool exec data-forge python -m data_forge.tools.llm batch-chat \
  --provider deepseek \
  --model deepseek-chat \
  --input-dir /path/to/prompts \
  --output-dir /path/to/responses \
  --system "You are a helpful assistant" \
  --keyfile /path/to/keys.json
```

### `batch-describe` — 批量图片描述

扫描输入目录中的所有图片文件，逐一调用视觉 LLM 生成描述，输出为同名的 `.txt` 文件。

**支持的图片格式：** `.jpg`、`.jpeg`、`.png`、`.gif`、`.webp`、`.bmp`、`.tiff`、`.avif` 等。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--provider` | string | ✅ | 提供商名称 |
| `--model` | string | ✅ | 视觉模型名称 |
| `--input-dir` | string | ✅ | 输入目录，包含图片文件（**必须使用绝对路径**） |
| `--output-dir` | string | ✅ | 输出目录，描述 `.txt` 文件保存位置（**必须使用绝对路径**） |
| `--keyfile` | string | ❌ | KEYFILE 路径（**必须使用绝对路径**） |
| `--prompt` | string | ❌ | 描述指令（默认 `Describe this image in detail.`） |
| `--temperature` | number | ❌ | 采样温度（默认 `0.7`） |
| `--max-tokens` | number | ❌ | 最大生成 token 数 |

**使用示例：**

```bash
hnflow-stack tool exec data-forge python -m data_forge.tools.llm batch-describe \
  --provider openai \
  --model gpt-4o \
  --input-dir /path/to/images \
  --output-dir /path/to/captions \
  --keyfile /path/to/keys.json
```

### `list-providers` — 列出已配置的提供商

读取 KEYFILE 并列出其中配置的所有提供商名称。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--keyfile` | string | ❌ | KEYFILE 路径（默认使用 `KEYFILE` 环境变量） |

**使用示例：**

```bash
hnflow-stack tool exec data-forge python -m data_forge.tools.llm list-providers \
  --keyfile /path/to/keys.json
```

输出示例：

```
openai
deepseek
groq
together
```
