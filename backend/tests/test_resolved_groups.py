"""Tests for deerflow.workflow.schema.collect_resolved_groups — capability-group resolution."""

from pathlib import Path

from deerflow.skills.catalog import SkillCatalog
from deerflow.skills.types import Skill, SkillCategory
from deerflow.workflow.schema import (
    Node,
    NodeType,
    WorkflowDefinition,
    collect_resolved_groups,
)


def _make_skill(
    name: str,
    skill_id: str | None = None,
    version: str = "0.1.0",
) -> Skill:
    """Construct a minimal Skill for test catalogs."""
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


def _make_definition(*group_sets: list[str]) -> WorkflowDefinition:
    """Build a WorkflowDefinition with one node per group list."""
    nodes = [Node(id=f"n{i}", type=NodeType.FLOW_START, capability_groups=groups) for i, groups in enumerate(group_sets)]
    return WorkflowDefinition(id="test-wf", name="Test", nodes=nodes)


class TestCollectResolvedGroups:
    """collect_resolved_groups unit tests."""

    def test_single_skill_resolves_to_guid_version(self):
        """A single capability_group maps to ``guid@version``."""
        catalog = SkillCatalog(skills=(_make_skill("data-analysis", skill_id="550e8400-e29b", version="0.2.0"),))
        definition = _make_definition(["data-analysis"])
        result = collect_resolved_groups(definition, catalog)
        assert result == ["550e8400-e29b@v0.2.0"]

    def test_duplicate_skill_deduplicated(self):
        """Two nodes referencing the same skill produce one entry."""
        catalog = SkillCatalog(skills=(_make_skill("data-analysis", skill_id="550e8400-e29b"),))
        definition = _make_definition(["data-analysis"], ["data-analysis"])
        result = collect_resolved_groups(definition, catalog)
        assert result == ["550e8400-e29b@v0.1.0"]

    def test_unknown_skill_name_skipped(self):
        """Unknown capability group name returns empty list."""
        catalog = SkillCatalog(skills=(_make_skill("known", skill_id="guid-known"),))
        definition = _make_definition(["unknown"])
        result = collect_resolved_groups(definition, catalog)
        assert result == []

    def test_skill_without_skill_id_skipped(self):
        """Skill with skill_id=None (public/legacy) is skipped."""
        catalog = SkillCatalog(skills=(_make_skill("legacy-skill", skill_id=None),))
        definition = _make_definition(["legacy-skill"])
        result = collect_resolved_groups(definition, catalog)
        assert result == []

    def test_empty_capability_groups_returns_empty(self):
        """Nodes with no capability_groups produce empty list."""
        catalog = SkillCatalog(skills=(_make_skill("unused", skill_id="guid"),))
        definition = _make_definition([])
        result = collect_resolved_groups(definition, catalog)
        assert result == []

    def test_multiple_different_skills_order_stable(self):
        """Multiple distinct skills are all collected in insertion order."""
        catalog = SkillCatalog(
            skills=(
                _make_skill("skill-a", skill_id="guid-a", version="0.1.0"),
                _make_skill("skill-b", skill_id="guid-b", version="0.2.0"),
                _make_skill("skill-c", skill_id="guid-c", version="1.0.0"),
            )
        )
        definition = _make_definition(["skill-a", "skill-b"], ["skill-c"])
        result = collect_resolved_groups(definition, catalog)
        assert result == ["guid-a@v0.1.0", "guid-b@v0.2.0", "guid-c@v1.0.0"]

    def test_mixed_known_and_unknown(self):
        """Unknown names are skipped while known ones resolve normally."""
        catalog = SkillCatalog(
            skills=(
                _make_skill("known", skill_id="guid-known"),
                _make_skill("no-id", skill_id=None),
            )
        )
        definition = _make_definition(["known", "unknown", "no-id"])
        result = collect_resolved_groups(definition, catalog)
        assert result == ["guid-known@v0.1.0"]

    def test_no_nodes_returns_empty(self):
        """WorkflowDefinition with no nodes returns empty list."""
        catalog = SkillCatalog(skills=(_make_skill("x", skill_id="guid-x"),))
        definition = WorkflowDefinition(id="empty", name="Empty")
        result = collect_resolved_groups(definition, catalog)
        assert result == []

    def test_empty_catalog_returns_empty(self):
        """Empty catalog with capability_groups returns empty list."""
        catalog = SkillCatalog(skills=())
        definition = _make_definition(["missing"])
        result = collect_resolved_groups(definition, catalog)
        assert result == []
