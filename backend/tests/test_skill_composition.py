"""Tests for N14 §5.5 capability-package composition (``extends`` / ``overlay``).

Three layers: the frontmatter parsing, the resolution/merge rules, and the two
consumers that must honour them (the AI node's tool union and the workflow's
resolved-group snapshot).
"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest

from deerflow.skills.composition import (
    COMPOSITION_MAX_DEPTH,
    CompositionError,
    resolve_allowed_tools,
    resolve_declaration,
    resolve_group_closure,
    validate_composition,
)
from deerflow.skills.parser import parse_extends, parse_overlay
from deerflow.skills.types import SecretRequirement, Skill, SkillCategory


def _skill(
    name: str,
    *,
    tools: tuple[str, ...] | None = None,
    extends: tuple[str, ...] = (),
    overlay: bool = False,
    permissions: tuple[str, ...] = (),
    secrets: tuple[SecretRequirement, ...] = (),
    schema_version: str | None = None,
    budget: int | None = None,
) -> Skill:
    return Skill(
        name=name,
        description=f"Skill {name}",
        license=None,
        skill_dir=Path("."),
        skill_file=Path("SKILL.md"),
        relative_path=Path("."),
        category=SkillCategory.CUSTOM,
        allowed_tools=tools,
        extends=extends,
        overlay=overlay,
        permissions=permissions,
        required_secrets=secrets,
        tool_schema_version=schema_version,
        context_budget=budget,
    )


# ── frontmatter parsing ───────────────────────────────────────────────────────


class TestParseExtends:
    def test_missing_is_empty(self) -> None:
        assert parse_extends(None, Path("SKILL.md")) == ()

    def test_single_string_and_list(self) -> None:
        assert parse_extends("base", Path("SKILL.md")) == ("base",)
        assert parse_extends(["a", "b"], Path("SKILL.md")) == ("a", "b")

    def test_trims_and_dedupes(self) -> None:
        assert parse_extends([" a ", "a", "b"], Path("SKILL.md")) == ("a", "b")

    @pytest.mark.parametrize("raw", [["a", 3], [""], ["  "], [None], 7])
    def test_malformed_entries_raise(self, raw: object) -> None:
        # Unlike a cosmetic optional field, a broken ``extends`` must not load
        # the package without the tools it declares it inherits.
        with pytest.raises(ValueError, match="extends in"):
            parse_extends(raw, Path("SKILL.md"))


class TestParseOverlay:
    def test_missing_is_false(self) -> None:
        assert parse_overlay(None, Path("SKILL.md")) is False

    def test_real_booleans(self) -> None:
        assert parse_overlay(True, Path("SKILL.md")) is True
        assert parse_overlay(False, Path("SKILL.md")) is False

    @pytest.mark.parametrize("raw", ["true", 1, 0, "no"])
    def test_non_boolean_raises(self, raw: object) -> None:
        # Reading "true" as truthy would silently narrow the tool set; reading a
        # typo as false would silently widen it. Both are rejected instead.
        with pytest.raises(ValueError, match="overlay in"):
            parse_overlay(raw, Path("SKILL.md"))


# ── resolution ────────────────────────────────────────────────────────────────


class TestResolveDeclaration:
    def test_undeclared_extends_is_the_identity(self) -> None:
        skill = _skill("solo", tools=("bash",))
        resolved = resolve_declaration(skill, {"solo": skill})
        assert resolved.allowed_tools == ("bash",)
        assert resolved.lineage == ("solo",)

    def test_extends_unions_allowed_tools(self) -> None:
        base = _skill("base", tools=("read_file", "bash"))
        child = _skill("child", tools=("write_file",), extends=("base",))
        resolved = resolve_declaration(child, {"base": base, "child": child})
        assert resolved.allowed_tools == ("read_file", "bash", "write_file")
        assert resolved.lineage == ("base", "child")

    def test_extends_without_own_tools_inherits(self) -> None:
        base = _skill("base", tools=("bash",))
        child = _skill("child", extends=("base",))
        assert resolve_declaration(child, {"base": base, "child": child}).allowed_tools == ("bash",)

    def test_overlay_replaces_instead_of_adding(self) -> None:
        base = _skill("base", tools=("read_file", "bash"))
        narrow = _skill("narrow", tools=("read_file",), extends=("base",), overlay=True)
        assert resolve_declaration(narrow, {"base": base, "narrow": narrow}).allowed_tools == ("read_file",)

    def test_overlay_without_own_list_narrows_to_nothing(self) -> None:
        base = _skill("base", tools=("bash",))
        empty = _skill("empty", extends=("base",), overlay=True)
        assert resolve_declaration(empty, {"base": base, "empty": empty}).allowed_tools is None

    def test_permissions_and_secrets_union(self) -> None:
        base = _skill("base", permissions=("fs",), secrets=(SecretRequirement(name="TOKEN"),))
        child = _skill("child", extends=("base",), permissions=("net",), secrets=(SecretRequirement(name="TOKEN"), SecretRequirement(name="KEY")))
        resolved = resolve_declaration(child, {"base": base, "child": child})
        assert resolved.permissions == ("fs", "net")
        assert [secret.name for secret in resolved.required_secrets] == ["TOKEN", "KEY"]

    def test_own_scalars_win_over_the_inherited_ones(self) -> None:
        base = _skill("base", schema_version="1", budget=100)
        child = _skill("child", extends=("base",))
        inherited = resolve_declaration(child, {"base": base, "child": child})
        assert (inherited.tool_schema_version, inherited.context_budget) == ("1", 100)

        own = _skill("own", extends=("base",), schema_version="2", budget=200)
        assert (resolve_declaration(own, {"base": base, "own": own}).tool_schema_version, resolve_declaration(own, {"base": base, "own": own}).context_budget) == ("2", 200)

    def test_multiple_bases_union_and_the_latest_scalar_wins(self) -> None:
        first = _skill("a", tools=("x",), schema_version="1")
        second = _skill("b", tools=("y",), schema_version="2")
        both = _skill("c", extends=("a", "b"))
        resolved = resolve_declaration(both, {"a": first, "b": second, "c": both})
        assert resolved.allowed_tools == ("x", "y")
        assert resolved.tool_schema_version == "2"

    def test_transitive_chain(self) -> None:
        grand = _skill("grand", tools=("a",))
        parent = _skill("parent", tools=("b",), extends=("grand",))
        child = _skill("child", tools=("c",), extends=("parent",))
        resolved = resolve_declaration(child, {"grand": grand, "parent": parent, "child": child})
        assert resolved.allowed_tools == ("a", "b", "c")
        assert resolved.lineage == ("grand", "parent", "child")

    def test_unknown_base_raises(self) -> None:
        child = _skill("child", extends=("ghost",))
        with pytest.raises(CompositionError, match="unknown capability group 'ghost'"):
            resolve_declaration(child, {"child": child})

    def test_self_extension_raises(self) -> None:
        loop = _skill("loop", extends=("loop",))
        with pytest.raises(CompositionError, match="extends itself"):
            resolve_declaration(loop, {"loop": loop})

    def test_cycle_raises_with_the_path(self) -> None:
        a = _skill("a", extends=("b",))
        b = _skill("b", extends=("a",))
        with pytest.raises(CompositionError, match="cycle: a -> b -> a"):
            resolve_declaration(a, {"a": a, "b": b})

    def test_depth_overrun_raises(self) -> None:
        catalog: dict[str, Skill] = {}
        for index in range(COMPOSITION_MAX_DEPTH + 3):
            name = f"g{index}"
            catalog[name] = _skill(name, extends=(f"g{index + 1}",))
        catalog[f"g{COMPOSITION_MAX_DEPTH + 3}"] = _skill(f"g{COMPOSITION_MAX_DEPTH + 3}")
        with pytest.raises(CompositionError, match="deeper than"):
            resolve_declaration(catalog["g0"], catalog)


class TestResolveAllowedTools:
    def test_none_when_nothing_declares(self) -> None:
        base = _skill("base")
        child = _skill("child", extends=("base",))
        assert resolve_allowed_tools(["child"], {"base": base, "child": child}) is None

    def test_inherited_tools_count_as_a_declaration(self) -> None:
        base = _skill("base", tools=("bash",))
        child = _skill("child", extends=("base",))
        assert resolve_allowed_tools(["child"], {"base": base, "child": child}) == {"bash"}

    def test_empty_set_when_a_group_declared_none_explicitly(self) -> None:
        empty = _skill("empty", tools=())
        assert resolve_allowed_tools(["empty"], {"empty": empty}) == set()

    def test_union_across_named_groups(self) -> None:
        a = _skill("a", tools=("x",))
        b = _skill("b", tools=("y",))
        assert resolve_allowed_tools(["a", "b"], {"a": a, "b": b}) == {"x", "y"}

    def test_unknown_name_is_skipped(self) -> None:
        a = _skill("a", tools=("x",))
        assert resolve_allowed_tools(["a", "ghost"], {"a": a}) == {"x"}

    def test_broken_composition_raises(self) -> None:
        child = _skill("child", extends=("ghost",))
        with pytest.raises(CompositionError):
            resolve_allowed_tools(["child"], {"child": child})


class TestResolveGroupClosure:
    def test_includes_transitive_bases_in_order(self) -> None:
        grand = _skill("grand")
        parent = _skill("parent", extends=("grand",))
        child = _skill("child", extends=("parent",))
        assert resolve_group_closure(["child"], {"grand": grand, "parent": parent, "child": child}) == ["child", "parent", "grand"]

    def test_unknown_names_stay_in_the_closure(self) -> None:
        # An authoring-time reference to a not-yet-installed package is reported
        # by validate_composition, not by the snapshot closure.
        assert resolve_group_closure(["ghost"], {}) == ["ghost"]

    def test_deduplicates_a_diamond(self) -> None:
        top = _skill("top")
        left = _skill("left", extends=("top",))
        right = _skill("right", extends=("top",))
        child = _skill("child", extends=("left", "right"))
        catalog = {"top": top, "left": left, "right": right, "child": child}
        assert resolve_group_closure(["child"], catalog) == ["child", "left", "right", "top"]


class TestValidateComposition:
    def test_clean_catalog_has_no_problems(self) -> None:
        base = _skill("base", tools=("a",))
        child = _skill("child", extends=("base",))
        assert validate_composition([base, child]) == []

    def test_reports_unknown_base(self) -> None:
        assert validate_composition([_skill("child", extends=("ghost",))]) == ["child: extends unknown capability group 'ghost'"]

    def test_reports_self_extension_and_cycles(self) -> None:
        problems = validate_composition([_skill("a", extends=("a",))])
        assert problems == ["a: capability group 'a' extends itself"]

    def test_reports_overlay_without_extends(self) -> None:
        assert validate_composition([_skill("only-overlay", overlay=True)]) == ["only-overlay: overlay requires extends (overlay alone does nothing)"]


# ── consumer: the AI node's tool union ────────────────────────────────────────


class TestToolUnionConsumer:
    def _catalog(self, monkeypatch: pytest.MonkeyPatch, skills: list[Skill], gateway_tools: dict[str, object]) -> None:
        from deerflow.workflow import tool_gateway as tg

        monkeypatch.setattr(tg, "_load_enabled_skills", lambda user_id: skills)
        monkeypatch.setattr(tg, "build_default_tool_gateway", lambda **kwargs: tg.ToolGateway([tg.StaticToolProvider("sandbox", gateway_tools)]))

    def test_child_inherits_the_base_tools(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from deerflow.workflow import tool_gateway as tg

        base = _skill("base", tools=("bash",))
        child = _skill("child", tools=("read_file",), extends=("base",))
        self._catalog(monkeypatch, [base, child], {"bash": _tool("bash"), "read_file": _tool("read_file"), "grep": _tool("grep")})

        resolved = tg.resolve_capability_tools(["child"], user_id="u1")

        assert [tool.name for tool in resolved] == ["bash", "read_file"]

    def test_overlay_narrows_the_inherited_set(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from deerflow.workflow import tool_gateway as tg

        base = _skill("base", tools=("bash", "read_file"))
        narrow = _skill("narrow", tools=("read_file",), extends=("base",), overlay=True)
        self._catalog(monkeypatch, [base, narrow], {"bash": _tool("bash"), "read_file": _tool("read_file")})

        resolved = tg.resolve_capability_tools(["narrow"], user_id="u1")

        assert [tool.name for tool in resolved] == ["read_file"]

    def test_broken_composition_yields_no_tools_instead_of_raising(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from deerflow.workflow import tool_gateway as tg

        orphan = _skill("orphan", tools=("bash",), extends=("ghost",))
        self._catalog(monkeypatch, [orphan], {"bash": _tool("bash")})

        assert tg.resolve_capability_tools(["orphan"], user_id="u1") == []


def _tool(name: str) -> object:
    from types import SimpleNamespace

    return SimpleNamespace(name=name, description=f"{name} tool", metadata=None)


# ── consumer: the workflow's resolved-group snapshot ──────────────────────────


class TestResolvedGroupsSnapshot:
    def _definition(self, groups: list[str]):
        from deerflow.workflow.schema import Node, NodeType, Port, PortType, WorkflowDefinition

        return WorkflowDefinition(
            id="wf-compose",
            name="Compose",
            nodes=[
                Node(id="start", type=NodeType.FLOW_START, outputs=[Port(name="out", type=PortType.DATA)]),
                Node(
                    id="ai",
                    type=NodeType.AI_LLM_AGENT,
                    params={"instruction": "x"},
                    inputs=[Port(name="in", type=PortType.DATA)],
                    outputs=[Port(name="out", type=PortType.DATA)],
                    capability_groups=groups,
                ),
            ],
        )

    def test_inherited_groups_join_the_snapshot(self) -> None:
        from deerflow.skills.catalog import SkillCatalog
        from deerflow.workflow.schema import collect_resolved_groups

        base = _skill("base", tools=("a",))
        base = replace(base, skill_id="guid-base")
        child = _skill("child", extends=("base",))
        child = replace(child, skill_id="guid-child")

        resolved = collect_resolved_groups(self._definition(["child"]), SkillCatalog(skills=(base, child)))

        assert resolved == ["guid-child@v0.1.0", "guid-base@v0.1.0"]

    def test_no_extends_is_unchanged(self) -> None:
        from deerflow.skills.catalog import SkillCatalog
        from deerflow.workflow.schema import collect_resolved_groups

        solo = _skill("solo", tools=("a",))
        solo = replace(solo, skill_id="guid-solo")

        assert collect_resolved_groups(self._definition(["solo"]), SkillCatalog(skills=(solo,))) == ["guid-solo@v0.1.0"]

    def test_unknown_inherited_group_is_skipped(self) -> None:
        from deerflow.skills.catalog import SkillCatalog
        from deerflow.workflow.schema import collect_resolved_groups

        child = _skill("child", extends=("ghost",))
        child = replace(child, skill_id="guid-child")

        assert collect_resolved_groups(self._definition(["child"]), SkillCatalog(skills=(child,))) == ["guid-child@v0.1.0"]
