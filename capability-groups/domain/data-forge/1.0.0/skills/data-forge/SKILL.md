---
name: data-forge
description: 当用户需要执行ComfyUI任务、图片缩放、图片格式转换、图片填充背景、图片去除背景、标注管理、LLM 生成图片描述时使用
---

# data-forge — AI 训练数据预处理工具集

data-forge 是一套可组合的 AI 训练数据集构建工具，覆盖从图片预处理到标注管理、LLM 描述生成再到 ComfyUI 合成图像的完整管线。

## 工具入口

工具代码位于 `tools/data-forge/0.2.1/`，统一通过 `hnflow-stack` 调用：

```bash
# 启动 MCP（由 DSH HNFlow 插件按能力组的工具引用挂载）
hnflow-stack tool serve data-forge

# 在工具环境中执行模块
hnflow-stack tool exec data-forge -- python -m data_forge.tools.convert --help
```

首次运行自动执行 `uv sync`。不要写死工具目录绝对路径。

## 路径规则

**所有文件路径参数必须使用绝对路径**，禁止使用相对路径。

## 使用方式

1. **MCP（推荐）**：`data-forge-mcp` 暴露 `resize_images`、`convert_image`、`convert_images`、`fill_background`、`fill_background_batch`、`remove_background`、`remove_background_batch`、`caption_*`、`llm_*`、`ollama_*`、`comfyui_*` 等工具。
2. **CLI**：仅以下模块提供命令行入口：

```bash
hnflow-stack tool exec data-forge python -m data_forge.tools.convert <子命令> [参数]
hnflow-stack tool exec data-forge python -m data_forge.tools.fill_background <子命令> [参数]
```

其余模块（resize / remove_bg / caption / llm / ollama / comfyui）是函数库，通过 MCP server 调用。

## 模块概览

| 能力 | 模块 |
|------|------|
| ComfyUI Client | `data_forge.tools.comfyui` |
| Image Resize | `data_forge.tools.resize` |
| Image Converter | `data_forge.tools.convert` |
| Background Fill | `data_forge.tools.fill_background` |
| Background Removal | `data_forge.tools.remove_bg` |
| Ollama Client | `data_forge.tools.ollama` |
| LLM Client | `data_forge.tools.llm` |
| Caption Editor | `data_forge.tools.caption` |

## 典型工作流

```
resize → [remove-bg] → [convert] → [fill-background] → Ollama / LLM → caption → ComfyUI
```

## 详细参考

- `comfyui.md`、`resize.md`、`convert.md`、`fill-background.md`
- `remove-bg.md`、`ollama.md`、`llm.md`、`caption.md`

参考文档中的参数表与 MCP 工具参数一一对应；CLI 只支持上表列出的 convert / fill_background。
