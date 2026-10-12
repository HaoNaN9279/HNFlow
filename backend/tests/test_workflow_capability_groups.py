"""Tests for workflow capability-group resolution and validation (C4).

``collect_resolved_groups`` maps skill names to ``guid@v<version>`` snapshots;
``validate_capability_groups`` reports names that are not installed.  Both are
pure functions over a ``SkillCatalog``.
"""

from __future__ import annotations

from pathlib import Path

from deerflow.skills.catalog import SkillCatalog
from deerflow.skills.types import Skill, SkillCategory
from deerflow.workflow.schema import (
    Node,
    NodeType,
    WorkflowDefinition,
    collect_resolved_groups,
    validate_capability_groups,
)


def _skill(name: str, skill_id: str | None = "guid", version: str = "0.1.0") -> Skill:
    return Skill(
        name=name,
        description=f"Skill {name}",
        license=None,
        skill_dir=Path("."),
        skill_file=Path("SKILL.md"),
        relative_path=Path("."),
        category=SkillCategory.CUSTOM,
        skill_id=skill_id,
        version=version,
    )


def _definition(var_groups: dict[str, list[str]]) -> WorkflowDefinition:
    nodes = [Node(id=nid, type=NodeType.FLOW_START, capability_groups=groups) for nid, groups in var_groups.items()]
    return WorkflowDefinition(id="wf-cap", name="Cap", nodes=nodes)


def test_collect_resolved_groups_maps_known_names() -> None:
    catalog = SkillCatalog(skills=(_skill("alpha", skill_id="g-alpha", version="0.2.0"),))
    result = collect_resolved_groups(_definition({"n1": ["alpha"]}), catalog)
    assert result == ["g-alpha@v0.2.0"]


def test_collect_resolved_groups_dedupes() -> None:
    catalog = SkillCatalog(skills=(_skill("alpha", skill_id="g-alpha"),))
    result = collect_resolved_groups(_definition({"n1": ["alpha"], "n2": ["alpha"]}), catalog)
    assert result == ["g-alpha@v0.1.0"]


def test_validate_capability_groups_reports_missing() -> None:
    catalog = SkillCatalog(skills=(_skill("known", skill_id="g-known"),))
    errors = validate_capability_groups(_definition({"n1": ["known", "ghost"]}), catalog)
    assert errors == ["node 'n1': capability group 'ghost' is not installed"]


def test_validate_capability_groups_empty_when_all_known() -> None:
    catalog = SkillCatalog(skills=(_skill("known", skill_id="g-known"),))
    assert validate_capability_groups(_definition({"n1": ["known"]}), catalog) == []
