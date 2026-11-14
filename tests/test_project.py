"""Project stack tests."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from hnflow_stack.errors import GroupAlreadyActiveError, GroupNotActiveError
from hnflow_stack.model import GroupRef
from hnflow_stack.project import (
    activate,
    deactivate,
    init_stack,
    lock_path,
    read_stack,
    resolve_order,
    stack_path,
    write_lock,
)


def test_init_defaults_to_core(repo: Path, project: Path) -> None:
    stack = init_stack(project, GroupRef("core", "0.1.0"))
    assert stack.core == GroupRef("core", "0.1.0")
    assert stack_path(project).is_file()


def test_activate_keeps_order_and_rejects_duplicates(repo: Path, project: Path) -> None:
    activate(project, GroupRef("data", ""), repo)
    activate(project, GroupRef("base", ""), repo)
    stack = read_stack(project)
    assert [ref.name for ref in stack.groups] == ["data", "base"]
    with pytest.raises(GroupAlreadyActiveError):
        activate(project, GroupRef("data", ""), repo)


def test_deactivate_removes_group(repo: Path, project: Path) -> None:
    activate(project, GroupRef("data", ""), repo)
    deactivate(project, "data")
    assert read_stack(project).groups == []
    with pytest.raises(GroupNotActiveError):
        deactivate(project, "data")


def test_resolve_order_puts_core_first_and_dependencies_before_group(
    repo: Path, project: Path
) -> None:
    init_stack(project, GroupRef("core", "0.1.0"))
    activate(project, GroupRef("data", ""), repo)
    stack = read_stack(project)
    assert [group.name for group in resolve_order(repo, stack)] == ["core", "base", "data"]


def test_write_lock_records_resolution(repo: Path, project: Path) -> None:
    init_stack(project, GroupRef("core", "0.1.0"))
    activate(project, GroupRef("data", ""), repo)
    stack = read_stack(project)
    path = write_lock(repo, project, stack)
    data = json.loads(path.read_text(encoding="utf-8"))
    assert path == lock_path(project)
    assert data["core"]["name"] == "core"
    assert [group["name"] for group in data["groups"]] == ["base", "data"]
