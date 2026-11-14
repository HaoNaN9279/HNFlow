"""DataForge MCP Server — exposes all DataForge tools as MCP tools.

Uses FastMCP for automatic schema generation from type hints.
Runs via stdio transport for MCP client integration.

Usage:
    uv run data-forge-mcp

Client configuration (e.g., Claude Desktop):
    {
      "mcpServers": {
        "data-forge": {
          "command": "uvx",
          "args": ["data-forge-mcp"]
        }
      }
    }
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from data_forge.tools._alpha import _parse_hex_color
from mcp.server.fastmcp import FastMCP

# ── FastMCP server instance ────────────────────────────────────────────────

mcp = FastMCP("DataForge", json_response=True)


# ── Helpers ────────────────────────────────────────────────────────────────

def _ok(message: str, **extra: Any) -> dict[str, Any]:
    """Build a success response."""
    return {"status": "ok", "message": message, **extra}


def _err(message: str, detail: str = "") -> dict[str, Any]:
    """Build an error response."""
    return {"status": "error", "message": message, "detail": detail}


def _format_paths(paths: list[Path]) -> list[str]:
    """Convert Path list to string list."""
    return [str(p) for p in paths]


# ── Resize ─────────────────────────────────────────────────────────────────

@mcp.tool()
def resize_images(
    input_dir: str,
    output_dir: str,
    width: int,
    height: int,
    fit_long_edge: bool = False,
    pad_to_fit: bool = False,
    overwrite: bool = False,
) -> dict[str, Any]:
    """Resize all images in a directory to a target resolution."""
    try:
        from data_forge.tools.resize import resize_images as _resize

        results = _resize(
            input_dir=input_dir,
            output_dir=output_dir,
            width=width,
            height=height,
            fit_long_edge=fit_long_edge,
            pad_to_fit=pad_to_fit,
            overwrite=overwrite,
        )
        return _ok(
            f"Resized {len(results)} images",
            count=len(results),
            files=_format_paths(results),
        )
    except FileNotFoundError as e:
        return _err("Input directory not found", str(e))
    except ValueError as e:
        return _err("Invalid parameters", str(e))
    except Exception as e:
        return _err("Resize failed", str(e))


# ── Convert ─────────────────────────────────────────────────────────────────

@mcp.tool()
def convert_image(
    input_path: str,
    output_path: str,
    background_color: str = "#FFFFFF",
) -> dict[str, Any]:
    """Convert a single image to another format (PNG, JPG, WebP, BMP)."""
    try:
        from data_forge.tools.convert import convert_image as _convert

        result = _convert(
            input_path,
            output_path,
            background_color=_parse_hex_color(background_color),
        )
        return _ok("Image converted", output=str(result))
    except FileNotFoundError as e:
        return _err("Input file not found", str(e))
    except ValueError as e:
        return _err("Invalid parameters", str(e))
    except Exception as e:
        return _err("Conversion failed", str(e))


@mcp.tool()
def convert_images(
    input_dir: str,
    output_dir: str,
    output_format: str,
    background_color: str = "#FFFFFF",
    overwrite: bool = False,
) -> dict[str, Any]:
    """Convert all images in a directory to another format."""
    try:
        from data_forge.tools.convert import convert_images as _convert_batch

        results = _convert_batch(
            input_dir,
            output_dir,
            output_format,
            background_color=_parse_hex_color(background_color),
            overwrite=overwrite,
        )
        return _ok(
            f"Converted {len(results)} images",
            count=len(results),
            files=_format_paths(results),
        )
    except FileNotFoundError as e:
        return _err("Input directory not found", str(e))
    except ValueError as e:
        return _err("Invalid parameters", str(e))
    except Exception as e:
        return _err("Batch conversion failed", str(e))


# ── Fill Background ─────────────────────────────────────────────────────────

@mcp.tool()
def fill_background(
    input_path: str,
    output_path: str,
    background_color: str = "#FFFFFF",
) -> dict[str, Any]:
    """Fill transparent areas of a single image with a background colour."""
    try:
        from data_forge.tools.fill_background import fill_background as _fill

        result = _fill(
            input_path,
            output_path,
            background_color=_parse_hex_color(background_color),
        )
        return _ok("Background filled", output=str(result))
    except FileNotFoundError as e:
        return _err("Input file not found", str(e))
    except ValueError as e:
        return _err("Invalid parameters", str(e))
    except Exception as e:
        return _err("Fill background failed", str(e))


@mcp.tool()
def fill_background_batch(
    input_dir: str,
    output_dir: str,
    background_color: str = "#FFFFFF",
    overwrite: bool = False,
) -> dict[str, Any]:
    """Fill transparent areas of all images in a directory with a background colour."""
    try:
        from data_forge.tools.fill_background import fill_background_batch as _fill_batch

        results = _fill_batch(
            input_dir,
            output_dir,
            background_color=_parse_hex_color(background_color),
            overwrite=overwrite,
        )
        return _ok(
            f"Background filled for {len(results)} images",
            count=len(results),
            files=_format_paths(results),
        )
    except FileNotFoundError as e:
        return _err("Input directory not found", str(e))
    except ValueError as e:
        return _err("Invalid parameters", str(e))
    except Exception as e:
        return _err("Batch fill background failed", str(e))


# ── Background Removal ─────────────────────────────────────────────────────

@mcp.tool()
def remove_background(
    input_path: str,
    output_path: str,
    model: str = "birefnet-general",
    alpha_matting: bool = False,
) -> dict[str, Any]:
    """Remove the background from a single image using BiRefNet."""
    try:
        from data_forge.tools.remove_bg import remove_background as _rm_bg

        result = _rm_bg(
            input_path=input_path,
            output_path=output_path,
            model=model,
            alpha_matting=alpha_matting,
        )
        return _ok("Background removed", output=str(result))
    except ImportError:
        return _err("rembg not installed. Run: uv sync --extra rembg")
    except FileNotFoundError as e:
        return _err("Input file not found", str(e))
    except Exception as e:
        return _err("Background removal failed", str(e))


@mcp.tool()
def remove_background_batch(
    input_dir: str,
    output_dir: str,
    model: str = "birefnet-general",
    alpha_matting: bool = False,
    overwrite: bool = False,
) -> dict[str, Any]:
    """Remove backgrounds from all images in a directory."""
    try:
        from data_forge.tools.remove_bg import remove_background_batch as _rm_batch

        results = _rm_batch(
            input_dir=input_dir,
            output_dir=output_dir,
            model=model,
            alpha_matting=alpha_matting,
            overwrite=overwrite,
        )
        return _ok(
            f"Background removed from {len(results)} images",
            count=len(results),
            files=_format_paths(results),
        )
    except ImportError:
        return _err("rembg not installed. Run: uv sync --extra rembg")
    except FileNotFoundError as e:
        return _err("Input directory not found", str(e))
    except Exception as e:
        return _err("Batch background removal failed", str(e))


# ── Captions ───────────────────────────────────────────────────────────────

@mcp.tool()
def caption_list(directory: str) -> dict[str, Any]:
    """List all .txt caption files in a directory."""
    try:
        from data_forge.tools.caption import list_captions

        results = list_captions(directory)
        return _ok(
            f"Found {len(results)} captions",
            count=len(results),
            files=[p.name for p in results],
        )
    except Exception as e:
        return _err("Failed to list captions", str(e))


@mcp.tool()
def caption_read(directory: str, filename: str) -> dict[str, Any]:
    """Read a single caption file's content."""
    try:
        from data_forge.tools.caption import read_caption

        content = read_caption(directory, filename)
        return _ok("Caption read", filename=filename, content=content)
    except FileNotFoundError as e:
        return _err("Caption not found", str(e))
    except Exception as e:
        return _err("Failed to read caption", str(e))


@mcp.tool()
def caption_read_all(directory: str) -> dict[str, Any]:
    """Read all caption files in a directory."""
    try:
        from data_forge.tools.caption import read_all_captions

        data = read_all_captions(directory)
        return _ok(
            f"Read {len(data)} captions",
            count=len(data),
            captions=data,
        )
    except Exception as e:
        return _err("Failed to read captions", str(e))


@mcp.tool()
def caption_search(
    directory: str,
    query: str,
    case_sensitive: bool = False,
    regex: bool = False,
) -> dict[str, Any]:
    """Search captions containing a query string."""
    try:
        from data_forge.tools.caption import search_captions

        results = search_captions(
            directory,
            query,
            case_sensitive=case_sensitive,
            regex=regex,
        )
        return _ok(
            f"Found {len(results)} matches",
            count=len(results),
            matches=results,
        )
    except Exception as e:
        return _err("Search failed", str(e))


@mcp.tool()
def caption_batch_replace(
    directory: str,
    old: str,
    new: str,
    case_sensitive: bool = False,
    regex: bool = False,
) -> dict[str, Any]:
    """Search-and-replace text across all captions in a directory."""
    try:
        from data_forge.tools.caption import batch_replace

        count = batch_replace(
            directory,
            old,
            new,
            case_sensitive=case_sensitive,
            regex=regex,
        )
        return _ok(
            f"Modified {count} files",
            files_modified=count,
        )
    except Exception as e:
        return _err("Replace failed", str(e))


@mcp.tool()
def caption_export(
    directory: str,
    output_path: str,
    fmt: str = "json",
) -> dict[str, Any]:
    """Export all captions to a JSON or CSV file."""
    try:
        from data_forge.tools.caption import export_captions

        result = export_captions(directory, output_path, fmt=fmt)
        return _ok("Captions exported", output=str(result))
    except Exception as e:
        return _err("Export failed", str(e))


@mcp.tool()
def caption_import(
    directory: str,
    input_path: str,
    overwrite: bool = False,
    fmt: str = "json",
) -> dict[str, Any]:
    """Import captions from a JSON or CSV file."""
    try:
        from data_forge.tools.caption import import_captions

        results = import_captions(directory, input_path, overwrite=overwrite, fmt=fmt)
        return _ok(
            f"Imported {len(results)} captions",
            count=len(results),
            files=_format_paths(results),
        )
    except FileNotFoundError as e:
        return _err("Import file not found", str(e))
    except Exception as e:
        return _err("Import failed", str(e))


@mcp.tool()
def caption_stats(directory: str) -> dict[str, Any]:
    """Get summary statistics for a caption directory."""
    try:
        from data_forge.tools.caption import caption_stats as _stats

        stats = _stats(directory)
        return _ok("Statistics computed", **stats)
    except Exception as e:
        return _err("Stats failed", str(e))


@mcp.tool()
def caption_deduplicate(directory: str, keep: str = "first") -> dict[str, Any]:
    """Remove duplicate captions from a directory."""
    try:
        from data_forge.tools.caption import deduplicate_captions

        removed = deduplicate_captions(directory, keep=keep)
        return _ok(
            f"Removed {len(removed)} duplicates",
            count=len(removed),
            removed=_format_paths(removed),
        )
    except Exception as e:
        return _err("Deduplicate failed", str(e))


# ── LLM (Cloud) ────────────────────────────────────────────────────────────

@mcp.tool()
def llm_chat(
    prompt: str,
    keyfile: str,
    provider: str,
    model: str,
    system: str | None = None,
    temperature: float = 0.7,
    max_tokens: int | None = None,
) -> dict[str, Any]:
    """Generate text using a cloud LLM provider (OpenAI-compatible API)."""
    try:
        from data_forge.tools.llm import chat

        text = chat(
            prompt,
            keyfile=keyfile,
            provider=provider,
            model=model,
            system=system,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        return _ok("Text generated", response=text)
    except FileNotFoundError as e:
        return _err("Keyfile not found", str(e))
    except ValueError as e:
        return _err("Invalid provider or config", str(e))
    except Exception as e:
        return _err("LLM chat failed", str(e))


@mcp.tool()
def llm_describe_image(
    image_path: str,
    keyfile: str,
    provider: str,
    model: str,
    prompt: str = "Describe this image in detail.",
    system: str | None = None,
    temperature: float = 0.7,
    max_tokens: int | None = None,
) -> dict[str, Any]:
    """Describe an image using a vision-capable cloud LLM."""
    try:
        from data_forge.tools.llm import describe_image

        text = describe_image(
            image_path,
            prompt=prompt,
            keyfile=keyfile,
            provider=provider,
            model=model,
            system=system,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        return _ok("Image described", response=text, image=image_path)
    except FileNotFoundError as e:
        return _err("File not found", str(e))
    except ValueError as e:
        return _err("Invalid provider or config", str(e))
    except Exception as e:
        return _err("Image description failed", str(e))


@mcp.tool()
def llm_batch_chat(
    prompts: list[str],
    output_dir: str,
    keyfile: str,
    provider: str,
    model: str,
    system: str | None = None,
    temperature: float = 0.7,
) -> dict[str, Any]:
    """Generate text for multiple prompts, saving each to a file."""
    try:
        from data_forge.tools.llm import batch_chat

        results = batch_chat(
            prompts,
            output_dir,
            keyfile=keyfile,
            provider=provider,
            model=model,
            system=system,
            temperature=temperature,
        )
        return _ok(
            f"Generated {len(results)} responses",
            count=len(results),
            files=_format_paths(results),
        )
    except Exception as e:
        return _err("Batch chat failed", str(e))


@mcp.tool()
def llm_batch_describe_images(
    input_dir: str,
    output_dir: str,
    keyfile: str,
    provider: str,
    model: str,
    prompt: str = "Describe this image in detail.",
    temperature: float = 0.7,
) -> dict[str, Any]:
    """Describe all images in a directory using a cloud LLM."""
    try:
        from data_forge.tools.llm import batch_describe_images

        results = batch_describe_images(
            input_dir,
            output_dir,
            keyfile=keyfile,
            provider=provider,
            model=model,
            prompt=prompt,
            temperature=temperature,
        )
        return _ok(
            f"Described {len(results)} images",
            count=len(results),
            files=_format_paths(results),
        )
    except Exception as e:
        return _err("Batch describe failed", str(e))


# ── Ollama (Local) ─────────────────────────────────────────────────────────

@mcp.tool()
def ollama_generate(
    prompt: str,
    model: str,
    base_url: str = "http://localhost:11434",
    system: str | None = None,
    temperature: float = 0.7,
) -> dict[str, Any]:
    """Generate text using a local Ollama model."""
    try:
        from data_forge.tools.ollama import generate_text

        text = generate_text(
            prompt,
            model=model,
            base_url=base_url,
            system=system,
            temperature=temperature,
        )
        return _ok("Text generated", response=text)
    except Exception as e:
        return _err("Ollama generation failed", str(e))


@mcp.tool()
def ollama_list_models(base_url: str = "http://localhost:11434") -> dict[str, Any]:
    """List installed Ollama models."""
    try:
        from data_forge.tools.ollama import OllamaClient

        client = OllamaClient(base_url)
        models = client.list_model_names()
        return _ok(f"Found {len(models)} models", models=models, count=len(models))
    except Exception as e:
        return _err("Failed to list models", str(e))


@mcp.tool()
def ollama_describe_image(
    image_path: str,
    model: str,
    prompt: str = "Describe this image in detail.",
    base_url: str = "http://localhost:11434",
) -> dict[str, Any]:
    """Describe an image using a local Ollama vision model."""
    try:
        from data_forge.tools.ollama import describe_image

        text = describe_image(
            image_path,
            prompt=prompt,
            model=model,
            base_url=base_url,
        )
        return _ok("Image described", response=text, image=image_path)
    except FileNotFoundError as e:
        return _err("Image not found", str(e))
    except Exception as e:
        return _err("Ollama image description failed", str(e))


@mcp.tool()
def ollama_batch_generate(
    prompts: list[str],
    output_dir: str,
    model: str,
    base_url: str = "http://localhost:11434",
    system: str | None = None,
    temperature: float = 0.7,
) -> dict[str, Any]:
    """Generate text for multiple prompts using local Ollama."""
    try:
        from data_forge.tools.ollama import batch_generate

        results = batch_generate(
            prompts,
            output_dir,
            model=model,
            base_url=base_url,
            system=system,
            temperature=temperature,
        )
        return _ok(
            f"Generated {len(results)} responses",
            count=len(results),
            files=_format_paths(results),
        )
    except Exception as e:
        return _err("Ollama batch generation failed", str(e))


@mcp.tool()
def ollama_batch_describe_images(
    input_dir: str,
    output_dir: str,
    model: str,
    prompt: str = "Describe this image in detail.",
    base_url: str = "http://localhost:11434",
) -> dict[str, Any]:
    """Describe all images in a directory using local Ollama vision model."""
    try:
        from data_forge.tools.ollama import batch_describe_images

        results = batch_describe_images(
            input_dir,
            output_dir,
            model=model,
            prompt=prompt,
            base_url=base_url,
        )
        return _ok(
            f"Described {len(results)} images",
            count=len(results),
            files=_format_paths(results),
        )
    except Exception as e:
        return _err("Ollama batch describe failed", str(e))


# ── ComfyUI ────────────────────────────────────────────────────────────────

@mcp.tool()
def comfyui_status(server_url: str = "http://127.0.0.1:8188") -> dict[str, Any]:
    """Check if a ComfyUI server is reachable and get queue size."""
    try:
        from data_forge.tools.comfyui import ComfyUIClient

        client = ComfyUIClient(server_url)
        alive = client.is_alive()
        queue = client.queue_size()
        return _ok(
            "Server status checked",
            alive=alive,
            queue_size=queue,
            server_url=server_url,
        )
    except Exception as e:
        return _err("Failed to check ComfyUI status", str(e))


@mcp.tool()
def comfyui_run_workflow(
    server_url: str,
    workflow_path: str,
    output_dir: str,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """Execute a ComfyUI workflow and download outputs."""
    try:
        from data_forge.tools.comfyui import run_workflow

        results = run_workflow(
            server_url,
            workflow_path,
            output_dir,
            timeout=timeout,
        )
        return _ok(
            f"Workflow completed, {len(results)} outputs",
            count=len(results),
            files=_format_paths(results),
        )
    except ConnectionError as e:
        return _err("ComfyUI server not reachable", str(e))
    except FileNotFoundError as e:
        return _err("Workflow file not found", str(e))
    except Exception as e:
        return _err("Workflow execution failed", str(e))


@mcp.tool()
def comfyui_run_batch(
    server_url: str,
    workflow_path: str,
    output_dir: str,
    param_list: str,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """Execute a ComfyUI workflow multiple times with different parameter sets.

    Args:
        param_list: JSON string of a list of node-override dicts.
            Example: '[{"88": {"inputs": {"string": "a cat"}}}, {"88": {"inputs": {"string": "a dog"}}}]'
    """
    try:
        from data_forge.tools.comfyui import run_batch

        params: list[dict[str, Any]] = json.loads(param_list)
        if not isinstance(params, list):
            return _err("param_list must be a JSON array of objects")

        results = run_batch(
            server_url,
            workflow_path,
            output_dir,
            param_list=params,
            timeout=timeout,
        )
        total = sum(len(r) for r in results)
        return _ok(
            f"Batch completed: {len(results)} workflows, {total} outputs",
            workflow_count=len(results),
            total_outputs=total,
        )
    except json.JSONDecodeError as e:
        return _err("Invalid JSON for param_list", str(e))
    except ConnectionError as e:
        return _err("ComfyUI server not reachable", str(e))
    except FileNotFoundError as e:
        return _err("Workflow file not found", str(e))
    except Exception as e:
        return _err("Batch execution failed", str(e))


# ── Server entry point ─────────────────────────────────────────────────────

def main() -> None:
    """Run the DataForge MCP server via stdio transport."""
    try:
        mcp.run(transport="stdio")
    except (ValueError, EOFError, BrokenPipeError):
        sys.exit(0)


if __name__ == "__main__":
    main()
