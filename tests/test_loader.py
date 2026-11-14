"""Group and tool loader tests."""

from __future__ import annotations

from pathlib import Path

import pytest

from hnflow_stack.errors import GroupNotFoundError
from hnflow_stack.loader import discover_groups, discover_tools, find_tool, load_group


def test_load_group_reads_metadata(repo: Path) -> None:
    group = load_group(repo, "data", "1.0.0")
    assert group.guid == "c" * 32
    assert group.extends == ["base"]
    assert group.rules[0].name == "data.md"


def test_load_group_picks_latest_version(repo: Path) -> None:
    group = load_group(repo, "base")
    assert group.version == "1.0.0"


def test_load_group_missing(repo: Path) -> None:
    with pytest.raises(GroupNotFoundError):
        load_group(repo, "missing")


def test_load_group_core_and_domain(repo: Path) -> None:
    assert load_group(repo, "core").root == repo / "capability-groups/core/0.1.0"
    assert load_group(repo, "data").root == repo / "capability-groups/domain/data/1.0.0"


def test_discover_groups_and_tools(repo: Path) -> None:
    assert {group.name for group in discover_groups(repo)} == {"core", "data", "base"}
    assert {tool.name for tool in discover_tools(repo)} == {"mcp-tool", "demo-tool"}


def test_flat_group_layout_is_not_discovered(repo: Path) -> None:
    config = repo / "capability-groups/legacy/1.0.0/group.json"
    config.parent.mkdir(parents=True)
    config.write_text(
        '{"guid":"' + "f" * 32 + '","name":"legacy","version":"1.0.0",'
        '"description":"legacy"}',
        encoding="utf-8",
    )
    assert "legacy" not in {group.name for group in discover_groups(repo)}
    with pytest.raises(GroupNotFoundError):
        load_group(repo, "legacy")


def test_find_tool_by_id_and_name(repo: Path) -> None:
    by_id = find_tool(repo, "tool:" + "d" * 32 + "@v0.1.0")
    by_name = find_tool(repo, "demo-tool")
    assert by_id.id == by_name.id
