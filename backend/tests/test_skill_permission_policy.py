"""Tests for §24.12 tool-level permission adjudication (least privilege).

The restriction is security-relevant, so the interesting cases are the refusals:
a tool that reaches outside the declaration, a tool whose requirement cannot be
stated at all, and the groups that must NOT be restricted because they never
asked for least privilege.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from deerflow.skills.composition import resolve_declaration
from deerflow.skills.parser import parse_skill_file
from deerflow.skills.permission_policy import (
    adjudicate,
    adjudicate_tools,
    required_permissions,
    summarize_denials,
    unknown_declared_permissions,
)
from deerflow.skills.types import Skill, SkillCategory

# ── 1. the requirement table ─────────────────────────────────────────────────


class TestRequiredPermissions:
    def test_known_tool_families(self) -> None:
        assert required_permissions("bash") == frozenset({"fs", "exec"})
        assert required_permissions("read_file") == frozenset({"fs"})
        assert required_permissions("write_file") == frozenset({"fs"})
        assert required_permissions("web_search") == frozenset({"net"})
        assert required_permissions("browser_click") == frozenset({"net"})

    def test_app_provider_tools_need_exec_regardless_of_name(self) -> None:
        # Local application driving spawns host processes; the provider is the
        # reliable signal, not the name.
        assert required_permissions("anything", provider="app") == frozenset({"exec"})
        assert required_permissions("app:launch") == frozenset({"exec"})

    def test_describe_only_tools_need_nothing(self) -> None:
        for name in ("present_files", "view_image", "ask_clarification"):
            assert required_permissions(name) == frozenset()

    def test_an_unknown_tool_has_no_stated_requirement(self) -> None:
        # ``None`` (not an empty set) — the difference is what makes a denial
        # possible instead of a silent assumption of harmlessness.
        assert required_permissions("mcp_foo_bar") is None
        assert required_permissions("run_arbitrary") is None

    def test_empty_name_needs_nothing(self) -> None:
        assert required_permissions("  ") == frozenset()


# ── 2. adjudication ──────────────────────────────────────────────────────────


class TestAdjudicate:
    def test_no_declaration_means_no_enforcement(self) -> None:
        decision = adjudicate((), "bash")
        assert decision.allowed is True
        assert "unrestricted" in decision.reason

    def test_allows_a_tool_inside_the_declaration(self) -> None:
        decision = adjudicate({"fs"}, "read_file")
        assert decision.allowed is True
        assert decision.required == frozenset({"fs"})
        assert decision.missing == frozenset()

    def test_denies_a_tool_reaching_outside(self) -> None:
        decision = adjudicate({"fs"}, "bash")
        assert decision.allowed is False
        assert decision.missing == frozenset({"exec"})
        assert "needs" in decision.reason
        assert "exec" in decision.reason

    def test_denies_an_unclassifiable_tool_and_names_the_knob(self) -> None:
        decision = adjudicate({"fs", "net"}, "mcp_mystery")
        assert decision.allowed is False
        assert decision.known is False
        assert "tool-permissions" in decision.reason

    def test_an_override_makes_an_unclassifiable_tool_decidable(self) -> None:
        decision = adjudicate({"net"}, "mcp_mystery", overrides={"mcp_mystery": ("net",)})
        assert decision.allowed is True
        assert decision.required == frozenset({"net"})

    def test_an_override_still_has_to_fit(self) -> None:
        decision = adjudicate({"fs"}, "mcp_mystery", overrides={"mcp_mystery": ("net", "exec")})
        assert decision.allowed is False
        assert decision.missing == frozenset({"net", "exec"})

    def test_an_empty_override_means_no_requirement(self) -> None:
        # Declaring "this tool needs nothing" must be expressible, otherwise an
        # opted-in group could never keep a harmless custom tool.
        decision = adjudicate({"fs"}, "my_helper", overrides={"my_helper": ()})
        assert decision.allowed is True
        assert decision.required == frozenset()

    def test_ignores_blank_declared_permissions(self) -> None:
        assert adjudicate({"", "  "}, "bash").allowed is True


class TestAdjudicateTools:
    def test_splits_and_preserves_order(self) -> None:
        allowed, denials = adjudicate_tools({"net"}, ["web_search", "read_file", "web_fetch"])
        assert allowed == ["web_search", "web_fetch"]
        assert [denial.tool for denial in denials] == ["read_file"]

    def test_reports_every_denial_with_a_reason(self) -> None:
        allowed, denials = adjudicate_tools({"fs"}, ["bash", "mcp_x", "read_file"])
        assert allowed == ["read_file"]
        assert len(denials) == 2
        summary = summarize_denials(denials)
        assert "bash" in summary
        assert "mcp_x" in summary

    def test_no_declaration_passes_everything_through(self) -> None:
        allowed, denials = adjudicate_tools(set(), ["bash", "mcp_anything"])
        assert allowed == ["bash", "mcp_anything"]
        assert denials == []

    def test_unknown_declared_permissions_are_reported(self) -> None:
        assert unknown_declared_permissions(["fs", "root"]) == ["root"]


# ── 3. frontmatter parsing ───────────────────────────────────────────────────


def _write_skill(tmp_path: Path, frontmatter: str) -> Path:
    skill_dir = tmp_path / "my-group"
    skill_dir.mkdir()
    skill_file = skill_dir / "SKILL.md"
    skill_file.write_text(f"---\nname: my-group\ndescription: does things\n{frontmatter}---\n\nBody.\n", encoding="utf-8")
    return skill_file


def _parse(tmp_path: Path, frontmatter: str) -> Skill | None:
    return parse_skill_file(_write_skill(tmp_path, frontmatter), SkillCategory.CUSTOM)


class TestParsing:
    def test_parses_tool_permissions(self, tmp_path: Path) -> None:
        skill = _parse(tmp_path, "tool-permissions:\n  mcp_x: [net, fs]\n")
        assert skill is not None
        assert skill.tool_permissions == {"mcp_x": ("net", "fs")}

    def test_defaults_to_an_empty_mapping(self, tmp_path: Path) -> None:
        skill = _parse(tmp_path, "")
        assert skill is not None
        assert skill.tool_permissions == {}

    def test_drops_unknown_permission_names_inside_an_entry(self, tmp_path: Path) -> None:
        skill = _parse(tmp_path, "tool-permissions:\n  mcp_x: [net, root]\n")
        assert skill is not None
        assert skill.tool_permissions == {"mcp_x": ("net",)}

    def test_ignores_a_malformed_mapping(self, tmp_path: Path) -> None:
        # Fail-soft, like ``permissions``: a typo in an optional declaration must
        # not make the package unloadable.
        skill = _parse(tmp_path, "tool-permissions: [net]\n")
        assert skill is not None
        assert skill.tool_permissions == {}

    def test_ignores_a_malformed_entry(self, tmp_path: Path) -> None:
        skill = _parse(tmp_path, "tool-permissions:\n  mcp_x: net\n")
        assert skill is not None
        assert skill.tool_permissions == {}


# ── 4. composition ───────────────────────────────────────────────────────────


def _skill(name: str, **kwargs: Any) -> Skill:
    return Skill(
        name=name,
        description="d",
        license=None,
        skill_dir=Path("/tmp") / name,
        skill_file=Path("/tmp") / name / "SKILL.md",
        relative_path=Path(name),
        category=__import__("deerflow.skills.types", fromlist=["SkillCategory"]).SkillCategory.CUSTOM,
        **kwargs,
    )


class TestComposition:
    def test_tool_permissions_union_per_tool(self) -> None:
        base = _skill("base", permissions=("fs",), tool_permissions={"mcp_x": ("fs",)})
        derived = _skill("derived", extends=("base",), tool_permissions={"mcp_x": ("net",), "mcp_y": ("exec",)})
        resolved = resolve_declaration(derived, {"base": base, "derived": derived})

        assert resolved.tool_permissions["mcp_x"] == ("fs", "net")
        assert resolved.tool_permissions["mcp_y"] == ("exec",)

    def test_inherited_permissions_count(self) -> None:
        base = _skill("base", permissions=("net",))
        derived = _skill("derived", extends=("base",), permissions=("fs",))
        resolved = resolve_declaration(derived, {"base": base, "derived": derived})
        assert set(resolved.permissions) == {"net", "fs"}


# ── 5. gateway integration ───────────────────────────────────────────────────


class _FakeGateway:
    def __init__(self) -> None:
        self.resolved: list[list[str]] = []

    def resolve_all(self, names: list[str]) -> list[str]:
        self.resolved.append(list(names))
        return list(names)


class TestGatewayIntegration:
    def _resolve(self, monkeypatch: pytest.MonkeyPatch, skills: list[Skill], groups: list[str]) -> tuple[list[str], _FakeGateway]:
        from deerflow.workflow import tool_gateway

        gateway = _FakeGateway()
        monkeypatch.setattr(tool_gateway, "_load_enabled_skills", lambda _user_id: skills)
        monkeypatch.setattr(tool_gateway, "build_default_tool_gateway", lambda **kwargs: gateway)
        return tool_gateway.resolve_capability_tools(groups, user_id="u"), gateway

    def test_unrestricted_groups_keep_every_declared_tool(self, monkeypatch: pytest.MonkeyPatch) -> None:
        group = _skill("g", allowed_tools=("bash", "read_file"))
        result, gateway = self._resolve(monkeypatch, [group], ["g"])

        assert sorted(result) == ["bash", "read_file"]
        assert gateway.resolved == [["bash", "read_file"]]

    def test_declared_permissions_filter_the_tool_set(self, monkeypatch: pytest.MonkeyPatch) -> None:
        group = _skill("g", allowed_tools=("bash", "read_file"), permissions=("fs",))
        result, gateway = self._resolve(monkeypatch, [group], ["g"])

        # ``bash`` needs exec as well -> denied; the node still gets read_file.
        assert result == ["read_file"]
        assert gateway.resolved == [["read_file"]]

    def test_an_unclassifiable_tool_is_denied_inside_an_opted_in_group(self, monkeypatch: pytest.MonkeyPatch) -> None:
        group = _skill("g", allowed_tools=("mcp_mystery", "read_file"), permissions=("fs",))
        result, _gateway = self._resolve(monkeypatch, [group], ["g"])

        assert result == ["read_file"]

    def test_a_tool_permissions_override_keeps_an_unclassifiable_tool(self, monkeypatch: pytest.MonkeyPatch) -> None:
        group = _skill("g", allowed_tools=("mcp_mystery",), permissions=("net",), tool_permissions={"mcp_mystery": ("net",)})
        result, _gateway = self._resolve(monkeypatch, [group], ["g"])

        assert result == ["mcp_mystery"]

    def test_a_group_whose_tools_all_violate_gets_none(self, monkeypatch: pytest.MonkeyPatch) -> None:
        group = _skill("g", allowed_tools=("bash",), permissions=("net",))
        result, gateway = self._resolve(monkeypatch, [group], ["g"])

        assert result == []
        # Never even asked the gateway: nothing survived adjudication.
        assert gateway.resolved == []

    def test_permissions_inherited_through_extends_restrict(self, monkeypatch: pytest.MonkeyPatch) -> None:
        base = _skill("base", permissions=("fs",))
        derived = _skill("derived", extends=("base",), allowed_tools=("bash", "read_file"))
        result, _gateway = self._resolve(monkeypatch, [base, derived], ["derived"])

        assert result == ["read_file"]

    def test_several_groups_union_their_permissions(self, monkeypatch: pytest.MonkeyPatch) -> None:
        fs_group = _skill("fs_group", allowed_tools=("read_file",), permissions=("fs",))
        exec_group = _skill("exec_group", allowed_tools=("bash",), permissions=("exec",))
        result, _gateway = self._resolve(monkeypatch, [fs_group, exec_group], ["fs_group", "exec_group"])

        # The union covers both tools; nobody is restricted by the other group's
        # narrower declaration.
        assert sorted(result) == ["bash", "read_file"]
