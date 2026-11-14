"""Workflow definitions owned by capability groups."""

from __future__ import annotations

import json
from pathlib import Path

from hnflow_stack.model import GroupRef
from hnflow_stack.preview import build_session
from hnflow_stack.project import activate, init_stack, read_stack, resolve_order, write_lock
from hnflow_stack.resolve import resolve_project


def _write_flow(root: Path, group: str, version: str, flow_id: str, **extra: object) -> Path:
    path = root / "capability-groups/domain" / group / version / "flows" / f"{flow_id}.flow.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "schemaVersion": 2,
        "flow": {
            "id": flow_id,
            "name": flow_id.replace("-", " ").title(),
            "description": f"{flow_id} description",
            "tags": ["demo"],
            **extra,
        },
        "input": {"type": "object", "properties": {}},
        "nodes": [],
        "edges": [],
    }
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def test_dependency_flows_are_visible_to_dependents(repo: Path, project: Path) -> None:
    _write_flow(repo, "base", "1.0.0", "base-check")
    _write_flow(repo, "data", "1.0.0", "data-report")
    init_stack(project, GroupRef("core", "0.1.0"))
    activate(project, GroupRef("data", ""), repo)

    plan = resolve_project(repo, project)

    assert [flow.id for flow in plan.flows] == ["base/base-check", "data/data-report"]
    assert plan.flows[0].group == "base"
    assert plan.flows[0].path.endswith("base-check.flow.json")


def test_flow_is_part_of_preview(repo: Path, project: Path) -> None:
    _write_flow(repo, "base", "1.0.0", "base-check")
    init_stack(project, GroupRef("core", "0.1.0"))
    activate(project, GroupRef("data", ""), repo)

    view = build_session(repo, project)
    section = next(section for section in view.sections if section.kind == "flows")

    assert [item.id for item in section.items] == ["base/base-check"]


def test_invalid_flow_is_a_warning(repo: Path, project: Path) -> None:
    path = _write_flow(repo, "base", "1.0.0", "broken")
    data = json.loads(path.read_text(encoding="utf-8"))
    data["schemaVersion"] = 1
    path.write_text(json.dumps(data), encoding="utf-8")
    init_stack(project, GroupRef("core", "0.1.0"))
    activate(project, GroupRef("data", ""), repo)

    plan = resolve_project(repo, project)

    assert plan.flows == []
    assert any("schemaVersion" in warning for warning in plan.warnings)


def test_lock_records_flows(repo: Path, project: Path) -> None:
    _write_flow(repo, "data", "1.0.0", "data-report")
    init_stack(project, GroupRef("core", "0.1.0"))
    activate(project, GroupRef("data", ""), repo)
    stack = read_stack(project)
    assert stack is not None

    path = write_lock(repo, project, stack)
    lock = json.loads(path.read_text(encoding="utf-8"))

    data = next(group for group in lock["groups"] if group["name"] == "data")
    assert data["flows"] == ["flows/data-report.flow.json"]


def test_resolve_order_supports_pinned_dependency(repo: Path, project: Path) -> None:
    group_path = repo / "capability-groups/domain/data/1.0.0/group.json"
    data = json.loads(group_path.read_text(encoding="utf-8"))
    data["extends"] = ["base@1.0.0"]
    group_path.write_text(json.dumps(data), encoding="utf-8")
    init_stack(project, GroupRef("core", "0.1.0"))
    activate(project, GroupRef("data", ""), repo)
    stack = read_stack(project)
    assert stack is not None

    order = resolve_order(repo, stack)

    assert [group.name for group in order] == ["core", "base", "data"]
    assert order[1].version == "1.0.0"
