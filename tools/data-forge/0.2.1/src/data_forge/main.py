"""DataForge MCP Server — single-file packaging entry point.

This module provides the canonical entry point for packaging DataForge
as a standalone executable via PyInstaller. It delegates to the MCP
server's main() function, which starts the stdio-based MCP transport.

Usage (development):
    uv run python -m data_forge.main

Usage (packaged):
    ./dist/data-forge
"""

from __future__ import annotations

from data_forge.mcp.server import main

if __name__ == "__main__":
    main()
