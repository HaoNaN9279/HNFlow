"""Tests for ``deerflow.workflow.dependency_graph`` — unified reference aggregation + cycle detection.

Covers:
- ``collect_subworkflow_refs``: template collection, inline recursion, dedup/order, malformed skip
- ``collect_skill_refs``: skill_id mapping, legacy (None skill_id) + unknown-name skip, dedup/order
- ``find_dependency_cycles``: workflow-only cycles, skill-only cycles, mixed (workflow→skill→skill) cycles,
  DAG empty result, determinism, 100+ node performance, missing-ref tolerance, namespace separation,
  skill without skill_id ignored.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from deerflow.skills.catalog import SkillCatalog
from deerflow.skills.types import DependencySpec, Skill, SkillCategory
from deerflow.workflow.dependency_graph import (
    collect_skill_refs,
    collect_subworkflow_refs,
    find_dependency_cycles,
)
from deerflow.workflow.schema import Node, NodeType, WorkflowDefinition

# ═══════════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════


def _make_def(*, id_: str = "wf", nodes: list[Node] | None = None, edges: list[Any] | None = None) -> WorkflowDefinition:
    return WorkflowDefinition(id=id_, name="Test Workflow", nodes=nodes or [], edges=edges or [])


def _sub_node(id_: str, *, template_id: str | None = None, inline_definition: dict[str, Any] | None = None) -> Node:
    if template_id is not None:
        spec: dict[str, Any] = {"type": "template", "template_id": template_id}
    else:
        spec = {"type": "inline", "definition": inline_definition}
    return Node(id=id_, type=NodeType.NESTED_SUBWORKFLOW, params={"subworkflow": spec})


def _cap_node(id_: str, capability_groups: list[str]) -> Node:
    return Node(id=id_, type=NodeType.DATA_ASSIGN, capability_groups=capability_groups)


def _make_skill(
    name: str,
    *,
    skill_id: str | None = None,
    dependencies: tuple[DependencySpec, ...] | None = None,
) -> Skill:
    return Skill(
        name=name,
        description="",
        license=None,
        skill_dir=Path("."),
        skill_file=Path("SKILL.md"),
        relative_path=Path(name),
        category=SkillCategory.PUBLIC,
        skill_id=skill_id,
        dependencies=dependencies,
    )


def _catalog(*skills: Skill) -> SkillCatalog:
    return SkillCatalog(tuple(skills))


# ═══════════════════════════════════════════════════════════════════════════════
# collect_subworkflow_refs
# ═══════════════════════════════════════════════════════════════════════════════


def test_collect_subworkflow_refs_template_dedup_order() -> None:
    """Template refs are collected, deduplicated, and order-stable."""
    wf = _make_def(
        id_="wf",
        nodes=[
            _sub_node("a", template_id="wf-2"),
            _sub_node("b", template_id="wf-3"),
            _sub_node("c", template_id="wf-2"),  # duplicate
        ],
    )
    assert collect_subworkflow_refs(wf) == ["wf-2", "wf-3"]


def test_collect_subworkflow_refs_inline_recursion() -> None:
    """Inline subgraphs are recursed; a nested template ref is collected."""
    inline = {
        "id": "wf-inline",
        "name": "Inline",
        "nodes": [
            {
                "id": "inner-sub",
                "type": "nested:subworkflow",
                "params": {"subworkflow": {"type": "template", "template_id": "wf-3"}},
            }
        ],
        "edges": [],
    }
    wf = _make_def(id_="wf", nodes=[_sub_node("sub", inline_definition=inline)])
    assert collect_subworkflow_refs(wf) == ["wf-3"]


def test_collect_subworkflow_refs_malformed_skipped() -> None:
    """A malformed subworkflow spec is skipped without raising."""
    wf = _make_def(
        id_="wf",
        nodes=[
            _sub_node("a", template_id="wf-2"),
            Node(id="bad", type=NodeType.NESTED_SUBWORKFLOW, params={"subworkflow": {"type": "nonsense"}}),
        ],
    )
    assert collect_subworkflow_refs(wf) == ["wf-2"]


# ═══════════════════════════════════════════════════════════════════════════════
# collect_skill_refs
# ═══════════════════════════════════════════════════════════════════════════════


def test_collect_skill_refs_maps_skill_id() -> None:
    """capability_groups names map to skill_id; legacy + unknown names skipped."""
    wf = _make_def(
        id_="wf",
        nodes=[
            _cap_node("a", ["cap-a", "unknown-cap"]),
            _cap_node("b", ["cap-b", "cap-a"]),  # duplicate cap-a
        ],
    )
    catalog = _catalog(
        _make_skill("cap-a", skill_id="guid-1"),
        _make_skill("cap-b", skill_id=None),  # legacy, ignored
        _make_skill("cap-c", skill_id="guid-3"),
    )
    assert collect_skill_refs(wf, catalog) == ["guid-1"]


# ═══════════════════════════════════════════════════════════════════════════════
# find_dependency_cycles
# ═══════════════════════════════════════════════════════════════════════════════


def test_workflow_cycle_detected() -> None:
    """Two workflows referencing each other by template_id form a cycle."""
    wf_a = _make_def(id_="wf-a", nodes=[_sub_node("s1", template_id="wf-b")])
    wf_b = _make_def(id_="wf-b", nodes=[_sub_node("s2", template_id="wf-a")])
    result = find_dependency_cycles({"wf-a": wf_a, "wf-b": wf_b}, [])
    assert len(result) == 1
    assert "workflow:wf-a" in result[0]
    assert "workflow:wf-b" in result[0]


def test_skill_cycle_detected() -> None:
    """Two skills depending on each other form a cycle."""
    g1 = _make_skill("cap-a", skill_id="guid-1", dependencies=(DependencySpec(guid="guid-2", version="0.1.0"),))
    g2 = _make_skill("cap-b", skill_id="guid-2", dependencies=(DependencySpec(guid="guid-1", version="0.1.0"),))
    result = find_dependency_cycles({}, [g1, g2])
    assert result == ["skill:guid-1 → skill:guid-2 → skill:guid-1"]


def test_mixed_workflow_to_skill_cycle_detected() -> None:
    """A workflow referencing a capability group whose skills cycle is detected."""
    wf = _make_def(id_="wf", nodes=[_cap_node("n1", ["cap-a"])])
    g1 = _make_skill("cap-a", skill_id="guid-1", dependencies=(DependencySpec(guid="guid-2", version="0.1.0"),))
    g2 = _make_skill("cap-b", skill_id="guid-2", dependencies=(DependencySpec(guid="guid-1", version="0.1.0"),))
    result = find_dependency_cycles({"wf": wf}, [g1, g2])
    assert result == ["skill:guid-1 → skill:guid-2 → skill:guid-1"]


def test_dag_returns_empty() -> None:
    """An acyclic workflow + skill graph returns no cycles."""
    wf_1 = _make_def(id_="wf-1", nodes=[_sub_node("s", template_id="wf-2")])
    wf_2 = _make_def(id_="wf-2")
    wf_3 = _make_def(id_="wf-3", nodes=[_cap_node("n", ["cap-a"])])
    g1 = _make_skill("cap-a", skill_id="guid-1", dependencies=(DependencySpec(guid="guid-2", version="0.1.0"),))
    g2 = _make_skill("cap-b", skill_id="guid-2")
    result = find_dependency_cycles({"wf-1": wf_1, "wf-2": wf_2, "wf-3": wf_3}, [g1, g2])
    assert result == []


def test_deterministic_output() -> None:
    """Two calls on the same graph produce identical results."""
    wf_a = _make_def(id_="wf-a", nodes=[_sub_node("s1", template_id="wf-b")])
    wf_b = _make_def(id_="wf-b", nodes=[_sub_node("s2", template_id="wf-a")])
    g1 = _make_skill("cap-a", skill_id="guid-1", dependencies=(DependencySpec(guid="guid-2", version="0.1.0"),))
    g2 = _make_skill("cap-b", skill_id="guid-2", dependencies=(DependencySpec(guid="guid-1", version="0.1.0"),))
    first = find_dependency_cycles({"wf-a": wf_a, "wf-b": wf_b}, [g1, g2])
    second = find_dependency_cycles({"wf-a": wf_a, "wf-b": wf_b}, [g1, g2])
    assert first == second


def test_large_chain_no_cycle_under_one_second() -> None:
    """120 chained workflows with no cycle finish fast and report nothing."""
    definitions = {}
    for i in range(120):
        node_id = f"wf-{i:03d}"
        if i < 119:
            definitions[node_id] = _make_def(id_=node_id, nodes=[_sub_node("s", template_id=f"wf-{i + 1:03d}")])
        else:
            definitions[node_id] = _make_def(id_=node_id)
    start = time.perf_counter()
    result = find_dependency_cycles(definitions, [])
    elapsed = time.perf_counter() - start
    assert result == []
    assert elapsed < 1.0


def test_missing_references_tolerated() -> None:
    """Missing template ids, unknown skill names, and missing dependency guids are no-ops."""
    wf = _make_def(
        id_="wf",
        nodes=[
            _sub_node("s1", template_id="wf-missing"),
            _cap_node("s2", ["unknown-cap"]),
        ],
    )
    g = _make_skill("known-cap", skill_id="guid-1", dependencies=(DependencySpec(guid="guid-missing", version="0.1.0"),))
    result = find_dependency_cycles({"wf": wf}, [g])
    assert result == []


def test_cross_type_same_id_not_connected() -> None:
    """A workflow id equal to a skill_id does not connect the two namespaces."""
    wf = _make_def(id_="x", nodes=[_cap_node("n", ["cap-x"])])
    g = _make_skill("cap-x", skill_id="x")
    result = find_dependency_cycles({"x": wf}, [g])
    assert result == []


def test_skill_without_skill_id_ignored() -> None:
    """A skill without skill_id is neither a node nor a cycle source."""
    g = _make_skill("cap-a", skill_id=None, dependencies=(DependencySpec(guid="cap-a", version="0.1.0"),))
    result = find_dependency_cycles({}, [g])
    assert result == []
