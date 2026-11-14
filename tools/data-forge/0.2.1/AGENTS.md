# AGENTS.md — AI Agent Usage Guide

This document describes how AI agents (code assistants, LLM-based tools, automation frameworks) should interact with the DataForge project.

## Project Purpose

DataForge is a Python toolkit for building AI training datasets. It provides tools for image preprocessing, caption management, LLM-based description generation, and synthetic image generation via ComfyUI. Each tool is a self-contained module with a clear input→process→output contract.

## Key Principles for Agents

### 1. Tool Discovery

- Browse `src/data_forge/tools/` to find available tools.
- Each tool module exposes functions with descriptive names and type hints.
- Check each tool's docstring for usage instructions, parameter descriptions, and examples.
- Available tools: `caption`, `comfyui`, `convert`, `fill_background`, `llm`, `ollama`, `remove_bg`, `resize`.

### MCP Tool Server

DataForge ships as an MCP (Model Context Protocol) server. AI agents running in MCP-compatible hosts (Claude Desktop, Cursor, Cline) can invoke DataForge tools directly through structured tool calls — no code import needed.

- Start with `uv run data-forge-mcp` (stdio transport).
- 24 MCP tools namespaced by domain: `caption_*`, `llm_*`, `ollama_*`, `comfyui_*`.
- All tools return structured JSON with `status` ("ok"/"error") and tool-specific data.
- Configure via the host's `mcpServers` using `uvx data-forge-mcp` as the launcher.
- The MCP server source is at `src/data_forge/mcp/server.py` (FastMCP).

### 2. Invoking Tools

Tools are plain Python functions. Import and call them directly:

```python
from data_forge.tools.resize import resize_images

result = resize_images(input_dir="/path/to/photos/", output_dir="/path/to/resized/", width=1024, height=1024)
```

Alternatively, invoke via CLI:

```bash
uv run data-forge
```

### 3. Tool Contract

Each tool in this project follows these conventions:

- **Input**: File paths (`str` or `Path`), PIL Images, or numpy arrays
- **Output**: File paths, PIL Images, or numpy arrays — consistent with the input type
- **Errors**: Raise specific exceptions with descriptive messages; never silently fail
- **Side effects**: File I/O only when an output path is explicitly provided

### 4. Adding New Tools

When adding a new data processing tool:

1. Create a new module in `src/data_forge/tools/` (e.g., `crop.py`)
2. Implement one or more functions with type hints and comprehensive docstrings (Google style)
3. Expose convenience functions at module level for quick single-call usage
4. Add any new dependencies to `pyproject.toml` under `[project.optional-dependencies]`

### 5. Dependency Management

- Core dependencies go in `[project] dependencies`
- Backend-specific dependencies (Pillow, OpenCV) and optional tools (rembg) go in `[project.optional-dependencies]`
- Use `uv add` or `uv remove` to manage dependencies — never edit `pyproject.toml` dependency lists by hand
- Run `uv lock` after dependency changes

### 6. Code Style

- Follow PEP 8 with 100-character line limit
- Use type hints on all public functions
- Docstrings follow Google style
- Use `from __future__ import annotations` in all modules
- Run `uv run ruff check src/` and `uv run ruff format src/` before committing

### 7. Testing

- Tests live in `tests/` at the project root
- Run with `uv run pytest`
- Each tool should have corresponding tests covering normal operation, edge cases, and error conditions
- Use `unittest.mock.patch` to mock external dependencies (network calls, rembg models)

### 8. Key Dependencies

- **Core**: `pillow`, `openai`, `requests`, `onnxruntime`
- **Optional**: `rembg` (background removal), `opencv-python` (OpenCV backend)
- **Dev**: `pytest`, `ruff`

## Environment

- Python >= 3.12
- Virtual environment managed by uv
- `pyproject.toml` is the single source of truth for project configuration
