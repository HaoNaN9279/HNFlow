"""Tests for the ``vibe-stack resolve --json`` client."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from deerflow.capability_groups import resolve as resolve_module
from deerflow.capability_groups.resolve import VibeStackResolveError, resolve_project_plan


def _write_group(root: Path, *, name: str, version: str, guid: str, tools: list[str] | None = None) -> Path:
    group_dir = root / "capability-groups" / name / version
    group_dir.mkdir(parents=True, exist_ok=True)
    (group_dir / "group.json").write_text(
        json.dumps(
            {
                "guid": guid,
                "name": name,
                "version": version,
                "description": f"{name} {version}",
                "permissions": ["fs"],
                "extends": [],
                "tools": tools or [],
                "tool_permissions": {"mcp:excel:read": ["net"]},
            }
        ),
        encoding="utf-8",
    )
    return group_dir


def _group_payload(root: Path, *, name: str, version: str, guid: str) -> dict[str, object]:
    return {
        "guid": guid,
        "name": name,
        "version": version,
        "description": f"{name} {version}",
        "root": str(root / "capability-groups" / name / version),
        "permissions": ["fs"],
        "extends": [],
        "tools": [],
    }


def _payload(repository: Path, project: Path) -> dict[str, object]:
    return {
        "schema_version": 1,
        "active": True,
        "repository": str(repository),
        "project": str(project),
        "core": _group_payload(repository, name="core", version="0.1.0", guid="a" * 32),
        "groups": [_group_payload(repository, name="excel", version="1.0.0", guid="b" * 32)],
        "rules": [{"name": "global", "path": "rules/00-global.md", "group": "core"}],
        "skills": [{"name": "sheet", "path": "skills/sheet", "group": "excel", "description": "Sheet"}],
        "mcp": {
            "vibe:core_codegraph": {"type": "local", "command": ["codegraph", "serve", "--mcp"], "enabled": True},
            "vibe:excel_workbook": {"type": "remote", "url": "https://example.test/mcp", "enabled": False},
        },
        "warnings": [],
        "fingerprint": "f" * 64,
    }


def _fake_run(monkeypatch: pytest.MonkeyPatch, *, stdout: str = "", returncode: int = 0, stderr: str = "") -> list[list[str]]:
    calls: list[list[str]] = []

    def run(command: list[str], **kwargs: object) -> SimpleNamespace:
        calls.append(command)
        return SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)

    monkeypatch.setattr(resolve_module.subprocess, "run", run)
    monkeypatch.setattr(resolve_module.shutil, "which", lambda name: r"C:\tools\vibe-stack.exe" if name == "vibe-stack" else None)
    return calls


def test_resolve_plan_parses_groups_rules_skills_tool_permissions_and_mcp(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    repository = tmp_path / "VibeStack"
    project = tmp_path / "project"
    project.mkdir()
    _write_group(repository, name="core", version="0.1.0", guid="a" * 32)
    _write_group(repository, name="excel", version="1.0.0", guid="b" * 32, tools=["mcp:excel:read"])
    calls = _fake_run(monkeypatch, stdout=json.dumps(_payload(repository, project)))

    plan = resolve_project_plan(project, repository=repository)

    assert calls == [[r"C:\tools\vibe-stack.exe", "resolve", "--json", "--project", str(project.resolve()), "--repo", str(repository)]]
    assert [group.name for group in plan.closure] == ["core", "excel"]
    assert plan.active_versions == {"core": "0.1.0", "excel": "1.0.0"}
    assert plan.groups[0].tool_permissions == {"mcp:excel:read": ("net",)}
    assert plan.rules[0]["name"] == "global"
    assert plan.skills[0]["name"] == "sheet"
    assert [(server.name, server.group, server.transport, server.enabled) for server in plan.mcp] == [
        ("vibe_core_codegraph", "core", "stdio", True),
        ("vibe_excel_workbook", "excel", "http", False),
    ]
    assert plan.mcp[0].command == ("codegraph", "serve", "--mcp")
    assert plan.fingerprint == "f" * 64


def test_resolve_plan_rejects_missing_cli(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    project = tmp_path / "project"
    project.mkdir()
    monkeypatch.setattr(resolve_module.shutil, "which", lambda name: None)

    with pytest.raises(VibeStackResolveError, match="CLI not found"):
        resolve_project_plan(project)


def test_resolve_plan_rejects_cli_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    project = tmp_path / "project"
    project.mkdir()
    _fake_run(monkeypatch, returncode=2, stderr="boom")

    with pytest.raises(VibeStackResolveError, match=r"\(exit 2\): boom"):
        resolve_project_plan(project)


def test_resolve_plan_rejects_unknown_schema(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    project = tmp_path / "project"
    project.mkdir()
    _fake_run(monkeypatch, stdout=json.dumps({"schema_version": 2}))

    with pytest.raises(VibeStackResolveError, match="schema_version 2"):
        resolve_project_plan(project)
