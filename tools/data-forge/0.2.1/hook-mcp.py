"""PyInstaller hook to collect hidden imports from the mcp package.

PyInstaller may fail to auto-detect all submodules and data files
in the mcp package. This hook collects mcp server dependencies while
excluding the CLI subpackage (which requires typer, not needed at runtime).
"""

from __future__ import annotations

from PyInstaller.utils.hooks import collect_all


def _filter(name: str) -> bool:
    """Exclude mcp.cli subpackage — requires typer, not needed for MCP server."""
    return not name.startswith("mcp.cli") and not name.startswith("mcp.server.cli")


datas, binaries, hiddenimports = collect_all("mcp", filter_submodules=_filter)
