"""Project-scoped VibeStack MCP servers merged into the MCP tool set."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from deerflow.capability_groups.vibestack import VibeStackGroupRef
from deerflow.config.extensions_config import ExtensionsConfig, McpServerConfig
from deerflow.mcp import project as project_module
from deerflow.workflow import tool_gateway
from deerflow.workflow.executors import ai as ai_executor


def _server(**overrides):
    data = {
        "key": "vibe:core_excel",
        "name": "vibe_core_excel",
        "group": "core",
        "transport": "stdio",
        "command": ["npx", "-y", "excel-mcp"],
        "url": None,
        "env": {"EXCEL_MODE": "read"},
        "headers": {},
        "enabled": True,
    }
    data.update(overrides)
    return data


def test_build_project_config_merges_stdio_and_http_servers():
    base = ExtensionsConfig(mcpServers={"global": McpServerConfig(type="stdio", command="uvx", args=["global"])})
    servers = [
        _server(),
        _server(
            key="vibe:core_remote",
            name="vibe_core_remote",
            transport="http",
            command=[],
            url="https://example.test/mcp",
            headers={"Authorization": "Bearer token"},
        ),
    ]

    config = project_module.build_project_extensions_config(servers, base=base)

    assert set(config.mcp_servers) == {"global", "vibe_core_excel", "vibe_core_remote"}
    stdio = config.mcp_servers["vibe_core_excel"]
    assert stdio.type == "stdio"
    assert stdio.command == "npx"
    assert stdio.args == ["-y", "excel-mcp"]
    assert stdio.env == {"EXCEL_MODE": "read"}
    remote = config.mcp_servers["vibe_core_remote"]
    assert remote.type == "http"
    assert remote.url == "https://example.test/mcp"
    assert remote.headers == {"Authorization": "Bearer token"}
    assert set(base.mcp_servers) == {"global"}


def test_build_project_config_rejects_stdio_without_command():
    with pytest.raises(ValueError, match="stdio transport requires a command"):
        project_module.build_project_extensions_config([_server(command=[])], base=ExtensionsConfig())


@pytest.mark.asyncio
async def test_get_project_mcp_tools_caches_per_plan(monkeypatch):
    calls = []

    async def fake_get_mcp_tools(*, extensions_config):
        calls.append(extensions_config)
        return [object()]

    monkeypatch.setattr(project_module, "get_mcp_tools", fake_get_mcp_tools)
    monkeypatch.setattr(project_module, "tag_mcp_tool", lambda tool: tool)
    project_module.reset_project_mcp_tools_cache()

    first = await project_module.get_project_mcp_tools([_server()], fingerprint="fp")
    second = await project_module.get_project_mcp_tools([_server()], fingerprint="fp")

    assert first is second
    assert len(calls) == 1
    assert calls[0].mcp_servers["vibe_core_excel"].command == "npx"


@pytest.mark.asyncio
async def test_ai_node_passes_project_mcp_tools_to_gateway(monkeypatch):
    tool = SimpleNamespace(name="vibe_core_excel_excel")
    captured = {}

    async def fake_project_tools(servers, *, fingerprint=None):
        captured["servers"] = servers
        captured["fingerprint"] = fingerprint
        return [tool]

    def fake_resolve(groups, **kwargs):
        captured["mcp_tools"] = kwargs.get("mcp_tools")
        return [tool]

    monkeypatch.setattr(project_module, "get_project_mcp_tools", fake_project_tools)
    monkeypatch.setattr(tool_gateway, "resolve_capability_tools", fake_resolve)

    tools = await ai_executor._resolve_node_tools(
        ["excel@1.0.0"],
        repository=Path("."),
        active={"excel": "1.0.0"},
        core=VibeStackGroupRef(name="core", version="0.1.0"),
        user_id="u",
        app_config=None,
        project_mcp_servers=[_server()],
        project_mcp_fingerprint="fp",
    )

    assert tools == [tool]
    assert captured["fingerprint"] == "fp"
    assert captured["mcp_tools"] == {"vibe_core_excel_excel": tool}
