"""Project-scoped MCP servers merged from VibeStack resolve plans.

VibeStack owns which MCP servers an activated capability group needs.  HNFlow
must not copy those entries into global ``extensions_config.json``: two
projects can use different tools, and Core/domain upgrades would drift.  This
module merges the resolve plan's MCP entries into an in-memory
``ExtensionsConfig`` and caches the discovered tools per plan fingerprint.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Mapping, Sequence
from typing import Any

from deerflow.config.extensions_config import ExtensionsConfig, McpServerConfig
from deerflow.mcp.tools import get_mcp_tools
from deerflow.tools.mcp_metadata import tag_mcp_tool

logger = logging.getLogger(__name__)

_project_tool_cache: dict[str, list[Any]] = {}


def _server_config(raw: Mapping[str, Any]) -> McpServerConfig:
    name = str(raw.get("name") or "").strip()
    if not name:
        raise ValueError("VibeStack MCP server must have a name")
    transport = str(raw.get("transport") or "stdio").lower()
    command_raw = raw.get("command") or []
    if not isinstance(command_raw, list) or not all(isinstance(part, str) for part in command_raw):
        raise ValueError(f"VibeStack MCP server {name!r}: command must be a list of strings")
    command = [part for part in command_raw if part]
    if transport == "stdio" and not command:
        raise ValueError(f"VibeStack MCP server {name!r}: stdio transport requires a command")
    url = raw.get("url")
    if url is not None and not isinstance(url, str):
        raise ValueError(f"VibeStack MCP server {name!r}: url must be a string")
    env = raw.get("env") or {}
    headers = raw.get("headers") or {}
    if not isinstance(env, dict) or not all(isinstance(key, str) and isinstance(value, str) for key, value in env.items()):
        raise ValueError(f"VibeStack MCP server {name!r}: env must be a string map")
    if not isinstance(headers, dict) or not all(isinstance(key, str) and isinstance(value, str) for key, value in headers.items()):
        raise ValueError(f"VibeStack MCP server {name!r}: headers must be a string map")
    return McpServerConfig(
        enabled=bool(raw.get("enabled", True)),
        type=transport,
        command=command[0] if command else None,
        args=command[1:],
        env=dict(env),
        url=url,
        headers=dict(headers),
        description=f"VibeStack MCP server {raw.get('key') or name}",
    )


def build_project_extensions_config(
    servers: Sequence[Mapping[str, Any]],
    *,
    base: ExtensionsConfig | None = None,
) -> ExtensionsConfig:
    """Merge VibeStack MCP entries over the operator's global config."""
    config = (base or ExtensionsConfig.from_file()).model_copy(deep=True)
    for raw in servers:
        name = str(raw.get("name") or "").strip()
        config.mcp_servers[name] = _server_config(raw)
    return config


def _cache_key(servers: Sequence[Mapping[str, Any]], fingerprint: str | None) -> str:
    if fingerprint:
        return fingerprint
    payload = json.dumps(list(servers), sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


async def get_project_mcp_tools(
    servers: Sequence[Mapping[str, Any]],
    *,
    fingerprint: str | None = None,
) -> list[Any]:
    """Load the merged global + project MCP tool set for one resolve plan."""
    config = build_project_extensions_config(servers)
    config_digest = hashlib.sha256(config.model_dump_json().encode("utf-8")).hexdigest()
    key = f"{_cache_key(servers, fingerprint)}:{config_digest}"
    cached = _project_tool_cache.get(key)
    if cached is not None:
        return cached
    tools = await get_mcp_tools(extensions_config=config)
    for tool in tools:
        tag_mcp_tool(tool)
    _project_tool_cache[key] = tools
    logger.info("Loaded %d project MCP tool(s) for fingerprint %s", len(tools), key[:12])
    return tools


def reset_project_mcp_tools_cache() -> None:
    _project_tool_cache.clear()


__all__ = [
    "build_project_extensions_config",
    "get_project_mcp_tools",
    "reset_project_mcp_tools_cache",
]
