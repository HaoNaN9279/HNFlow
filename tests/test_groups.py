"""Tests for the capability-group inventory behind the workspace window."""

from __future__ import annotations

import json
from pathlib import Path

from hnflow_stack.groups import active_names, groups_document


def _stack(project: Path, groups: list[str]) -> None:
    """Write the project stack that decides activation."""
    payload = {
        "schema_version": 2,
        "core": {"name": "core", "version": "0.1.0"},
        "groups": [{"name": name, "version": "1.0.0"} for name in groups],
    }
    target = project / ".hnflow" / "stack.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def test_lists_inactive_groups_with_their_activation_state(repo: Path, project: Path) -> None:
    _stack(project, ["data"])
    document = groups_document(repo, project)
    groups = {group["name"]: group for group in document["groups"]}

    assert set(groups) == {"core", "base", "data"}
    assert groups["core"]["fixed"] is True and groups["core"]["active"] is True
    assert groups["data"]["active"] is True
    assert groups["base"]["active"] is False, "an unlisted group must still be listed, as inactive"
    assert groups["core"]["source"] == "repo"
    assert groups["core"]["description"] == "core"
    assert document["stack"]["core"]["name"] == "core"
    assert active_names(project) == ["data"]


def test_inventories_every_content_kind(repo: Path, project: Path) -> None:
    _stack(project, [])
    groups = {group["name"]: group for group in groups_document(repo, project)["groups"]}
    core = groups["core"]["contents"]

    assert [item["id"] for item in core["rules"]] == ["core/rules/00-global.md"]
    assert [item["id"] for item in core["agents"]] == ["core/agents/helper.md"]
    assert [item["id"] for item in core["skills"]] == ["core/skills/core-skill/SKILL.md"]
    assert core["commands"] == [] and core["references"] == [] and core["flows"] == []

    rule = core["rules"][0]
    assert rule["name"] == "global"
    assert rule["description"] == "global rules"
    assert rule["scope"] == "global"
    assert rule["paths"] == []
    assert rule["on_demand"] is False
    assert rule["priority"] == 0

    skill = core["skills"][0]
    assert skill["name"] == "core-skill"
    assert Path(skill["path"]).is_file(), "a preview item must point at a real file"


def test_rule_policy_fields_come_from_frontmatter(repo: Path, project: Path) -> None:
    path = repo / "capability-groups/domain/data/1.0.0/rules/data.md"
    path.write_text(
        "---\nname: data\ndescription: data rules\nscope: paths\npaths: ['Assets/**']\n"
        "on_demand: true\npriority: 40\n---\n\n# data\n",
        encoding="utf-8",
    )
    _stack(project, ["data"])
    groups = {group["name"]: group for group in groups_document(repo, project)["groups"]}
    rule = groups["data"]["contents"]["rules"][0]

    assert rule["scope"] == "paths"
    assert rule["paths"] == ["Assets/**"]
    assert rule["on_demand"] is True
    assert rule["priority"] == 40
