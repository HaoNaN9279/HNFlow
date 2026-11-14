# DataForge

AI training data pipeline toolkit — forge image datasets, manage captions, and generate synthetic data with LLMs and ComfyUI.

## Overview

DataForge provides a set of composable tools for building AI training datasets. It handles the full pipeline: image preprocessing, caption management, LLM-based description generation, and synthetic image generation via ComfyUI.

### Tools

| Tool | Module | Purpose |
|---|---|---|
| **Caption Editor** | `caption.py` | Batch CRUD, search/replace, deduplication, JSON/CSV import/export, analytics for caption `.txt` files |
| **ComfyUI Client** | `comfyui.py` | Connect to ComfyUI, submit workflows, track execution, download generated images |
| **LLM Client** | `llm.py` | Multi-provider text generation & image description via OpenAI-compatible APIs |
| **Ollama Client** | `ollama.py` | Local model inference — text generation & vision model image description |
| **Background Removal** | `remove_bg.py` | Remove image backgrounds using BiRefNet models via rembg |
| **Image Resize** | `resize.py` | Batch resize with aspect-ratio preservation and padding |

## Installation

### Option 1: Standalone Binary (Recommended for MCP)

[![Build](https://github.com/HaoNaN9279/data_forge/actions/workflows/build.yml/badge.svg)](https://github.com/HaoNaN9279/data_forge/actions/workflows/build.yml)

Download the latest release binary from the [Releases page](https://github.com/HaoNaN9279/data_forge/releases):

| Platform | File |
|---|---|
| Windows x64 | `data-forge-windows-x64.exe` |
| Linux x64 | `data-forge-linux-x64` |
| macOS x64 | `data-forge-macos-x64` |

**No Python or dependencies required.** Just download, make executable (Linux/macOS), and configure your MCP client:

```json
{
  "mcpServers": {
    "data-forge": {
      "command": "/path/to/data-forge-windows-x64.exe"
    }
  }
}
```

### Option 2: Python (uv)

#### Prerequisites

- Python >= 3.12
- [uv](https://docs.astral.sh/uv/) (recommended) or pip

#### Using uv (recommended)

```bash
git clone https://github.com/HaoNaN9279/DataForge.git
cd DataForge

# Install core dependencies
uv sync

# Install with optional dependencies
uv sync --extra rembg    # Background removal
uv sync --extra opencv   # OpenCV backend
uv sync --extra pillow   # Pillow backend
```

#### Using pip

```bash
pip install -e .
pip install -e ".[rembg]"
```

## Usage

### CLI

```bash
uv run data-forge
```

### MCP Server

DataForge includes a full MCP (Model Context Protocol) server exposing all tools as MCP tools. Connect it to any MCP-compatible client (Claude Desktop, Cline, Cursor, etc.).

**Quick start:**

```bash
uv run data-forge-mcp
```

**Client configuration:**

```json
{
  "mcpServers": {
    "data-forge": {
      "command": "uvx",
      "args": ["data-forge-mcp"]
    }
  }
}
```

Or with a local clone:

```json
{
  "mcpServers": {
    "data-forge": {
      "command": "uv",
      "args": ["run", "--directory", "/path/to/DataForge", "data-forge-mcp"]
    }
  }
}
```

**Available MCP Tools (24)**

| Category | Tools |
|---|---|
| **Resize** | `resize_images` |
| **Background Removal** | `remove_background`, `remove_background_batch` |
| **Captions** | `caption_list`, `caption_read`, `caption_read_all`, `caption_search`, `caption_batch_replace`, `caption_export`, `caption_import`, `caption_stats`, `caption_deduplicate` |
| **LLM (Cloud)** | `llm_chat`, `llm_describe_image`, `llm_batch_chat`, `llm_batch_describe_images` |
| **Ollama (Local)** | `ollama_generate`, `ollama_list_models`, `ollama_describe_image`, `ollama_batch_generate`, `ollama_batch_describe_images` |
| **ComfyUI** | `comfyui_status`, `comfyui_run_workflow`, `comfyui_run_batch` |

All tools return structured JSON with `status` ("ok"/"error"), `message`, and tool-specific data.

### Programmatic

```python
# --- Caption editor ---
from data_forge.tools.caption import CaptionEditor

editor = CaptionEditor("/path/to/captions/")
editor.create("img01.txt", "a cat sitting on a windowsill")
results = editor.search("cat")
editor.replace("cat", "kitten")
stats = editor.stats()

# --- Image resize ---
from data_forge.tools.resize import resize_images

resize_images("/path/to/raw_images/", "/path/to/resized/", 1024, 1024, pad_to_fit=True)

# --- Background removal ---
from data_forge.tools.remove_bg import remove_background, remove_background_batch

remove_background("/path/to/photo.jpg", "/path/to/cutout.png", model="birefnet-general")
remove_background_batch("/path/to/photos/", "/path/to/cutouts/")

# --- LLM image description ---
from data_forge.tools.llm import describe_image, batch_describe_images

desc = describe_image("/path/to/photo.jpg", keyfile="/path/to/keys.json", provider="openai", model="gpt-4o")
batch_describe_images("/path/to/images/", "/path/to/captions/", keyfile="/path/to/keys.json", provider="openai", model="gpt-4o")

# --- Local Ollama inference ---
from data_forge.tools.ollama import generate_text, describe_image

text = generate_text("Explain this image", model="llama3.2")
desc = describe_image("/path/to/photo.jpg", model="llava")

# --- ComfyUI image generation ---
from data_forge.tools.comfyui import run_workflow, run_batch

run_workflow("http://127.0.0.1:8188", "/path/to/workflow.json", "/path/to/output/")
```

### End-to-End Pipeline Example

```python
"""Generate training images from text prompts via ComfyUI."""
from pathlib import Path
from data_forge.tools.comfyui import ComfyUIClient, _load_workflow, _deep_merge

client = ComfyUIClient("http://127.0.0.1:8188")
workflow = _load_workflow("/path/to/flux2-klein_t2i.json")

for prompt_file in Path("/path/to/prompts/").glob("*.txt"):
    prompt_text = prompt_file.read_text().strip()
    wf = _deep_merge(workflow, {"88": {"inputs": {"string": prompt_text}}})
    client.run(wf, f"/path/to/output/{prompt_file.stem}")
```

## Project Structure

```
DataForge/
├── src/
│   └── data_forge/       # Main package
│       ├── __init__.py   # Package init + CLI entry point
│       ├── tools/        # Individual tools
│       │   ├── caption.py
│       │   ├── comfyui.py
│       │   ├── llm.py
│       │   ├── ollama.py
│       │   ├── remove_bg.py
│       │   └── resize.py
│       └── resources/    # API keys, ComfyUI workflows (git-ignored)
├── tests/                # pytest test suite
├── pyproject.toml        # Project metadata and dependencies
├── data-forge.spec       # PyInstaller packaging spec
├── hook-mcp.py           # PyInstaller hook for mcp package
├── build.md              # Build and packaging guide
├── AGENTS.md             # AI agent usage guidelines
├── .github/workflows/    # CI build and release pipeline
└── README.md
```

## Development

```bash
# Install dev dependencies
uv sync

# Run tests (170+ tests)
uv run pytest

# Lint
uv run ruff check src/

# Format
uv run ruff format src/
```

## License

MIT
