from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from langchain_core.tools import BaseTool, tool

from deerflow.capability_groups import discovery as group_discovery
from deerflow.tools.mcp_metadata import tag_mcp_origin, tag_mcp_tool
from deerflow.tools.registry import ToolRegistry, ToolResolutionError
from deerflow.workflow import tool_gateway as tg


@tool
def alpha(value: str) -> str:
    """Alpha tool."""
    return value


@tool
def beta(value: str) -> str:
    """Beta tool."""
    return value


@tool
def network_tool(value: str) -> str:
    """Network tool."""
    return value


class FakeGateway:
    def __init__(self, *, builtin: dict[str, BaseTool] | None = None, mcp: dict[str, BaseTool] | None = None, app: dict[str, BaseTool] | None = None) -> None:
        self.providers = [
            SimpleNamespace(name="builtin", tools=builtin or {}),
            SimpleNamespace(name="sandbox", tools={}),
            SimpleNamespace(name="mcp", tools=mcp or {}),
            SimpleNamespace(name="app", tools=app or {}),
        ]

    def resolve(self, name: str, *, provider: str | None = None) -> BaseTool | None:
        for candidate in self.providers:
            if provider is not None and candidate.name != provider:
                continue
            tool_ = candidate.tools.get(name)
            if tool_ is not None:
                return tool_
        return None


def _mcp_tool(name: str, *, server: str = "srv", original: str = "ping") -> SimpleNamespace:
    result = SimpleNamespace(name=name, description="mcp", metadata=None)
    tag_mcp_tool(result)
    tag_mcp_origin(result, server=server, tool_name=original)
    return result


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _package(root: Path, *, name: str = "demo", guid: str = "a" * 32, **extra: object) -> Path:
    package_dir = root / name / "0.1.0"
    manifest = {
        "schema_version": 1,
        "guid": guid,
        "name": name,
        "version": "0.1.0",
        "description": "Demo tool",
        "provider": "python",
        "entrypoint": "tool.py:build_tool",
        **extra,
    }
    _write(package_dir / "tool.json", json.dumps(manifest))
    _write(
        package_dir / "tool.py",
        'from langchain_core.tools import tool\n\n@tool\ndef custom(value: str) -> str:\n    """Custom tool."""\n    return value\n\ndef build_tool():\n    return custom\n',
    )
    return package_dir


def _group(root: Path, *, name: str, guid: str, tools: list[str], permissions: list[str] | None = None, extends: list[str] | None = None, extra: dict[str, object] | None = None) -> None:
    manifest = {
        "guid": guid,
        "name": name,
        "version": "0.1.0",
        "description": name,
        "permissions": permissions or [],
        "extends": extends or [],
        "tools": tools,
        **(extra or {}),
    }
    _write(root / name / "0.1.0" / "group.json", json.dumps(manifest))


def test_registry_descriptors_include_packages_mcp_and_provider_tools(tmp_path: Path) -> None:
    _package(tmp_path)
    registry = ToolRegistry(FakeGateway(builtin={"alpha": alpha}, mcp={"srv_ping": _mcp_tool("srv_ping")}), package_root=tmp_path)

    ids = {entry["id"] for entry in registry.descriptors()}

    assert f"tool:{'a' * 32}@v0.1.0" in ids
    assert "mcp:srv:ping" in ids
    assert "builtin:alpha" in ids


def test_registry_resolves_provider_and_mcp_refs() -> None:
    mcp = _mcp_tool("srv_ping")
    registry = ToolRegistry(FakeGateway(builtin={"alpha": alpha}, mcp={"srv_ping": mcp}))

    assert registry.resolve_ref("builtin:alpha").tool is alpha
    assert registry.resolve_ref("mcp:srv:ping").tool is mcp
    assert registry.resolve_ref("mcp:srv:srv_ping").tool is mcp


def test_registry_rejects_missing_mcp_tool() -> None:
    registry = ToolRegistry(FakeGateway())

    with pytest.raises(ToolResolutionError, match="not available"):
        registry.resolve_ref("mcp:srv:ping")


def test_registry_loads_custom_python_package_and_renames(tmp_path: Path) -> None:
    _package(tmp_path, tool_name="renamed")
    registry = ToolRegistry(FakeGateway(), package_root=tmp_path)

    binding = registry.resolve_ref(f"tool:{'a' * 32}@v0.1.0")

    assert isinstance(binding.tool, BaseTool)
    assert binding.tool.name == "renamed"
    assert binding.package is not None
    assert binding.provider == "python"


def test_registry_wraps_python_factory_failures(tmp_path: Path) -> None:
    package_dir = tmp_path / "demo" / "0.1.0"
    _write(
        package_dir / "tool.json",
        json.dumps(
            {
                "guid": "f" * 32,
                "name": "demo",
                "version": "0.1.0",
                "provider": "python",
                "entrypoint": "tool.py:build_tool",
            }
        ),
    )
    _write(package_dir / "tool.py", "def build_tool():\n    raise RuntimeError('boom')\n")
    registry = ToolRegistry(FakeGateway(), package_root=tmp_path)

    with pytest.raises(ToolResolutionError, match="factory .* failed: boom"):
        registry.resolve_ref(f"tool:{'f' * 32}@v0.1.0")


def test_registry_deduplicates_refs_and_rejects_name_collisions() -> None:
    registry = ToolRegistry(FakeGateway(builtin={"alpha": alpha}, mcp={"alpha": _mcp_tool("alpha", original="alpha")}))

    assert registry.resolve(["builtin:alpha", "builtin:alpha"], permissions=()) == [alpha]
    with pytest.raises(ToolResolutionError, match="declared by both"):
        registry.resolve(["builtin:alpha", "mcp:srv:alpha"], permissions=())


def test_registry_enforces_manifest_permissions(tmp_path: Path) -> None:
    _package(tmp_path, permissions=["net"])
    registry = ToolRegistry(FakeGateway(), package_root=tmp_path)

    with pytest.raises(ToolResolutionError, match="needs \\['net'\\]"):
        registry.resolve([f"tool:{'a' * 32}@v0.1.0"], permissions=("fs",))
    assert registry.resolve([f"tool:{'a' * 32}@v0.1.0"], permissions=("net",))


def test_registry_treats_explicit_empty_manifest_permissions_as_no_requirement(tmp_path: Path) -> None:
    _package(tmp_path, permissions=[])
    registry = ToolRegistry(FakeGateway(), package_root=tmp_path)

    resolved = registry.resolve([f"tool:{'a' * 32}@v0.1.0"], permissions=("fs",))

    assert [tool.name for tool in resolved] == ["demo"]


def test_registry_uses_group_permission_override_for_unknown_mcp_name() -> None:
    registry = ToolRegistry(FakeGateway(mcp={"srv_ping": _mcp_tool("srv_ping")}))

    with pytest.raises(ToolResolutionError, match="no known permission requirement"):
        registry.resolve(["mcp:srv:ping"], permissions=("net",))
    assert registry.resolve(["mcp:srv:ping"], permissions=("net",), overrides={"mcp:srv:ping": ("net",)})


def test_resolve_capability_tools_loads_groups_and_extends(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _group(tmp_path, name="base", guid="b" * 32, tools=["builtin:beta"])
    _group(tmp_path, name="child", guid="c" * 32, tools=["builtin:alpha"], extends=["base"])
    monkeypatch.setattr(group_discovery, "_roots", lambda user_id=None, project_roots=(): [group_discovery._RootSpec(path=tmp_path, source="public", project_id=None, root_id=None, priority=0)])
    monkeypatch.setattr(tg, "build_default_tool_gateway", lambda **kwargs: FakeGateway(builtin={"alpha": alpha, "beta": beta}))

    resolved = tg.resolve_capability_tools(["child"])

    assert resolved == [alpha, beta]


def test_resolve_capability_tools_fails_on_missing_declared_tool(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _group(tmp_path, name="demo", guid="d" * 32, tools=["builtin:missing"])
    monkeypatch.setattr(group_discovery, "_roots", lambda user_id=None, project_roots=(): [group_discovery._RootSpec(path=tmp_path, source="public", project_id=None, root_id=None, priority=0)])
    monkeypatch.setattr(tg, "build_default_tool_gateway", lambda **kwargs: FakeGateway())

    with pytest.raises(ToolResolutionError, match="builtin tool 'missing' is not available"):
        tg.resolve_capability_tools(["demo"])


def test_resolve_capability_tools_returns_empty_without_refs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _group(tmp_path, name="demo", guid="e" * 32, tools=[])
    monkeypatch.setattr(group_discovery, "_roots", lambda user_id=None, project_roots=(): [group_discovery._RootSpec(path=tmp_path, source="public", project_id=None, root_id=None, priority=0)])
    monkeypatch.setattr(tg, "build_default_tool_gateway", lambda **kwargs: pytest.fail("gateway should not be built"))

    assert tg.resolve_capability_tools(["demo"]) == []
