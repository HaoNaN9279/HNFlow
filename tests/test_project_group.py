"""Project-local capability groups under ``.hnflow/groups``."""

from __future__ import annotations

import json
from pathlib import Path

from hnflow_stack.loader import load_group
from hnflow_stack.model import GroupRef
from hnflow_stack.project import activate, init_stack, read_stack
from hnflow_stack.resolve import MODE_CAPABILITIES, resolve_project


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _write_json(path: Path, data: dict) -> None:
    _write(path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def _project_group(project: Path, name: str = "local") -> Path:
    root = project / ".hnflow" / "groups" / name
    _write_json(
        root / "group.json",
        {
            "guid": "f" * 32,
            "name": name,
            "description": "project group",
            "permissions": ["fs"],
            "extends": [],
            "tools": [],
        },
    )
    _write(
        root / "rules" / "local.md",
        "---\nname: local-rule\ndescription: local rules\n---\n\n# local\n",
    )
    return root


def test_project_group_loads_without_a_version_directory(
    repo: Path, project: Path
) -> None:
    root = _project_group(project)
    group = load_group(repo, "local", project=project)
    assert group.version == ""
    assert group.root == root
    assert [path.name for path in group.rules] == ["local.md"]


def test_project_group_shadows_the_repository_group(repo: Path, project: Path) -> None:
    _project_group(project, "data")
    group = load_group(repo, "data", project=project)
    assert group.version == ""
    assert group.description == "project group"


def test_versioned_reference_to_a_project_group_is_rejected(
    repo: Path, project: Path
) -> None:
    _project_group(project)
    try:
        load_group(repo, "local", "1.0.0", project=project)
    except Exception as exc:  # noqa: BLE001 - the error type is asserted below
        assert "version '1.0.0' not found" in str(exc)
    else:  # pragma: no cover - the reference must fail
        raise AssertionError("a versioned project group reference must fail")


def test_activate_a_project_group_writes_a_versionless_ref(
    repo: Path, project: Path
) -> None:
    _project_group(project)
    activate(project, GroupRef("local", ""), repo)
    stack = read_stack(project)
    assert stack is not None
    assert [(ref.name, ref.version) for ref in stack.groups] == [("local", "")]


def test_resolve_includes_project_group_rules(repo: Path, project: Path) -> None:
    _project_group(project)
    init_stack(project, GroupRef("core", "0.1.0"))
    activate(project, GroupRef("local", ""), repo)
    plan = resolve_project(repo, project, mode=MODE_CAPABILITIES)
    assert plan.warnings == []
    assert [rule.name for rule in plan.rules] == ["global", "local-rule"]
    assert [group.name for group in plan.groups] == ["local"]
