"""Tests for ``deerflow.workflow.tool_gateway`` (N1) and the AI-node tool
assembly (C1) that consumes it.

The gateway maps tool ids to concrete tools via ordered providers; the AI-node
executor resolves its capability groups' ``allowed-tools`` union through it.
Heavy providers (real sandbox / config tool assembly) are stubbed so these tests
stay hermetic.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from deerflow.skills.types import Skill, SkillCategory
from deerflow.workflow import tool_gateway as tg
from deerflow.workflow.compiler import WorkflowRuntime
from deerflow.workflow.executors import exec_llm_agent

# ── Helpers ──────────────────────────────────────────────────────────────────


def _tool(name: str) -> SimpleNamespace:
    # ``metadata`` is what ``tag_mcp_tool`` writes to (real ``BaseTool``s always
    # carry the attribute), so the double must have it too.
    return SimpleNamespace(name=name, description=f"{name} tool", metadata=None)


def _skill(name: str, allowed_tools: tuple[str, ...] | None = None) -> Skill:
    return Skill(
        name=name,
        description=f"Skill {name}",
        license=None,
        skill_dir=Path("."),
        skill_file=Path("SKILL.md"),
        relative_path=Path("."),
        category=SkillCategory.CUSTOM,
        skill_id="guid",
        version="0.1.0",
        allowed_tools=allowed_tools,
    )


# ── ToolGateway ──────────────────────────────────────────────────────────────


class TestToolGateway:
    def test_resolve_first_provider_wins(self) -> None:
        a = tg.StaticToolProvider("a", {"x": _tool("x")})
        b = tg.StaticToolProvider("b", {"x": _tool("b-x"), "y": _tool("b-y")})
        gateway = tg.ToolGateway([a, b])
        assert gateway.resolve("x").name == "x"  # provider a wins
        assert gateway.resolve("y").name == "b-y"
        assert gateway.resolve("missing") is None

    def test_resolve_all_preserves_order_and_skips_unknown(self) -> None:
        gateway = tg.ToolGateway([tg.StaticToolProvider("a", {"x": _tool("x"), "z": _tool("z")})])
        resolved = gateway.resolve_all(["z", "nope", "x"])
        assert [t.name for t in resolved] == ["z", "x"]

    def test_descriptors_dedupe_across_providers(self) -> None:
        a = tg.StaticToolProvider("a", {"x": _tool("x")})
        b = tg.StaticToolProvider("b", {"x": _tool("x"), "y": _tool("y")})
        ids = sorted(d.id for d in tg.ToolGateway([a, b]).descriptors())
        assert ids == ["x", "y"]


# ── resolve_capability_tools ─────────────────────────────────────────────────


class _FakeExtensionsConfig:
    def __init__(self, servers: dict[str, Any]) -> None:
        self._servers = servers

    def get_enabled_mcp_servers(self) -> dict[str, Any]:
        return self._servers


def _patch_mcp(monkeypatch: pytest.MonkeyPatch, *, servers: dict[str, Any], tools: list[Any]) -> None:
    """Patch the MCP config + cache the provider reads."""
    import deerflow.config.extensions_config as ec
    import deerflow.mcp.cache as mcp_cache

    monkeypatch.setattr(ec.ExtensionsConfig, "from_file", classmethod(lambda cls, *a, **k: _FakeExtensionsConfig(servers)))
    monkeypatch.setattr(mcp_cache, "get_cached_mcp_tools", lambda: list(tools))


class TestMcpProvider:
    def test_mcp_tools_resolve_from_the_mcp_provider(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(tg, "_sandbox_tools", lambda: {})
        monkeypatch.setattr(tg, "_builtin_tools", lambda **kwargs: {"bash": _tool("bash")})
        monkeypatch.setattr(tg, "_app_tools", lambda **kwargs: {})
        _patch_mcp(monkeypatch, servers={"srv": {"enabled": True}}, tools=[_tool("srv_ping")])

        gateway = tg.build_default_tool_gateway()

        assert gateway.provider_names() == ["sandbox", "builtin", "mcp", "app"]
        assert gateway.resolve_with_provider("srv_ping") == (gateway.resolve("srv_ping"), tg.PROVIDER_MCP)

    def test_mcp_tools_keep_their_server_origin(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from deerflow.tools.mcp_metadata import get_mcp_origin, tag_mcp_origin

        monkeypatch.setattr(tg, "_sandbox_tools", lambda: {})
        monkeypatch.setattr(tg, "_builtin_tools", lambda **kwargs: {})
        monkeypatch.setattr(tg, "_app_tools", lambda **kwargs: {})
        mcp_tool = _tool("srv_ping")
        tag_mcp_origin(mcp_tool, server="srv", tool_name="ping")
        _patch_mcp(monkeypatch, servers={"srv": {"enabled": True}}, tools=[mcp_tool])

        gateway = tg.build_default_tool_gateway()

        assert get_mcp_origin(gateway.resolve("srv_ping")) == ("srv", "ping")

    def test_mcp_tools_keep_their_deferred_filter_tag(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from deerflow.tools.mcp_metadata import is_mcp_tool

        monkeypatch.setattr(tg, "_sandbox_tools", lambda: {})
        monkeypatch.setattr(tg, "_builtin_tools", lambda **kwargs: {})
        monkeypatch.setattr(tg, "_app_tools", lambda **kwargs: {})
        _patch_mcp(monkeypatch, servers={"srv": {"enabled": True}}, tools=[_tool("srv_ping")])

        gateway = tg.build_default_tool_gateway()

        # ``ai:llm_agent`` resolves tools through this gateway, so the tag the
        # deferred-tool filter keys on must survive the provider split.
        assert is_mcp_tool(gateway.resolve("srv_ping")) is True

    def test_no_enabled_servers_yields_no_mcp_tools(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(tg, "_sandbox_tools", lambda: {})
        monkeypatch.setattr(tg, "_builtin_tools", lambda **kwargs: {})
        monkeypatch.setattr(tg, "_app_tools", lambda **kwargs: {})
        _patch_mcp(monkeypatch, servers={}, tools=[_tool("srv_ping")])

        gateway = tg.build_default_tool_gateway()

        assert gateway.resolve("srv_ping") is None
        assert "mcp" in gateway.provider_names()  # registered, just empty

    def test_config_failure_fails_open(self, monkeypatch: pytest.MonkeyPatch) -> None:
        import deerflow.config.extensions_config as ec

        monkeypatch.setattr(tg, "_sandbox_tools", lambda: {})
        monkeypatch.setattr(tg, "_builtin_tools", lambda **kwargs: {})
        monkeypatch.setattr(tg, "_app_tools", lambda **kwargs: {})
        monkeypatch.setattr(ec.ExtensionsConfig, "from_file", classmethod(lambda cls, *a, **k: (_ for _ in ()).throw(RuntimeError("no config"))))

        gateway = tg.build_default_tool_gateway()

        assert "mcp" in gateway.provider_names()
        assert gateway.resolve("srv_ping") is None

    def test_builtin_provider_assembles_without_mcp(self, monkeypatch: pytest.MonkeyPatch) -> None:
        captured: dict[str, Any] = {}

        def _fake_available(**kwargs: Any) -> list[Any]:
            captured.update(kwargs)
            return [_tool("bash")]

        monkeypatch.setattr("deerflow.tools.tools.get_available_tools", _fake_available)

        builtin = tg._builtin_tools(model_name=None, app_config=None)

        assert captured["include_mcp"] is False  # MCP comes from its own provider
        assert "bash" in builtin
        assert {"spec_lint", "mock_verifier", "dafny_verify", "tla_model_check", "lean_check", "cel_evaluate"} <= set(builtin)

    def test_mcp_name_does_not_shadow_a_builtin_name(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(tg, "_sandbox_tools", lambda: {})
        monkeypatch.setattr(tg, "_builtin_tools", lambda **kwargs: {"dup": _tool("builtin-dup")})
        monkeypatch.setattr(tg, "_app_tools", lambda **kwargs: {})
        _patch_mcp(monkeypatch, servers={"srv": {"enabled": True}}, tools=[_tool("dup")])

        gateway = tg.build_default_tool_gateway()

        assert gateway.resolve("dup").name == "builtin-dup"
        assert gateway.resolve_with_provider("dup")[1] == tg.PROVIDER_BUILTIN


# ── C1 wiring: exec_llm_agent passes resolved tools to the sub-agent ─────────


@pytest.mark.asyncio
async def test_exec_llm_agent_fails_loud_when_declared_tool_is_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    from deerflow.tools.registry import ToolResolutionError
    from deerflow.workflow.registry import WorkflowExecutionError

    monkeypatch.setattr(
        "deerflow.workflow.tool_gateway.resolve_capability_tools",
        lambda *args, **kwargs: (_ for _ in ()).throw(ToolResolutionError("builtin tool 'missing' is not available")),
    )
    monkeypatch.setattr("deerflow.workflow.executors.ai.load_capability_rules", lambda *args, **kwargs: [])
    monkeypatch.setattr("deerflow.workflow.executors.ai.load_capability_skills", lambda *args, **kwargs: [])

    with pytest.raises(WorkflowExecutionError, match="missing"):
        await exec_llm_agent(
            WorkflowRuntime(),
            {"capability_groups": ["grp"]},
            {"in": "y", "template_prompt": "x"},
        )


@pytest.mark.asyncio
async def test_exec_llm_agent_passes_resolved_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    sentinel = [_tool("bash")]
    monkeypatch.setattr("deerflow.workflow.executors.ai._resolve_node_tools", lambda *args, **kwargs: sentinel)
    monkeypatch.setattr("deerflow.workflow.executors.ai.load_capability_rules", lambda *args, **kwargs: [])
    monkeypatch.setattr("deerflow.workflow.executors.ai.load_capability_skills", lambda *args, **kwargs: [])

    captured: dict[str, Any] = {}

    class FakeExecutor:
        def __init__(self, **kwargs: Any) -> None:
            captured.update(kwargs)

        async def _aexecute(self, task: str, result_holder: Any = None) -> Any:
            return SimpleNamespace(status=SimpleNamespace(value="completed"), result="ok", error=None)

    import deerflow.subagents as subagents_pkg

    monkeypatch.setattr(subagents_pkg, "SubagentExecutor", FakeExecutor)

    result = await exec_llm_agent(
        WorkflowRuntime(),
        {"capability_groups": ["grp"]},
        {"in": "y", "template_prompt": "x"},
    )

    assert result["out"]["content"] == "ok"
    assert result["__workflow_prompt"]
    assert captured["tools"] is sentinel
