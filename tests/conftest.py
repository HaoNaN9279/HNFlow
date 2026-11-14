"""Test fixtures for HNFlow."""

from __future__ import annotations

import json
from pathlib import Path

import pytest


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


@pytest.fixture(autouse=True)
def isolated_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the home directory at the test temp dir."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("HNFLOW_MODELS_FILE", str(tmp_path / "no-project-models.json"))
    return home


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """Build a minimal HNFlow repository fixture."""
    root = tmp_path / "repo"
    _write_json(
        root / "capability-groups/core/0.1.0/group.json",
        {
            "guid": "a" * 32,
            "name": "core",
            "version": "0.1.0",
            "description": "core",
            "permissions": ["fs"],
            "extends": [],
            "tools": ["tool:" + "b" * 32 + "@v0.1.0"],
        },
    )
    _write(
        root / "capability-groups/core/0.1.0/rules/00-global.md",
        "---\nname: global\n---\n\n# global\n",
    )
    _write(
        root / "capability-groups/core/0.1.0/agents/helper.md",
        "---\nname: Helper\ndescription: helper agent\nmode: subagent\n---\n\n# Helper\n",
    )
    _write(
        root / "capability-groups/core/0.1.0/skills/core-skill/SKILL.md",
        "---\nname: core-skill\ndescription: core skill\n---\n\n# Core skill\n",
    )

    _write_json(
        root / "capability-groups/domain/data/1.0.0/group.json",
        {
            "guid": "c" * 32,
            "name": "data",
            "version": "1.0.0",
            "description": "data group",
            "permissions": ["fs"],
            "extends": ["base"],
            "tools": ["tool:" + "d" * 32 + "@v0.1.0"],
        },
    )
    _write(
        root / "capability-groups/domain/data/1.0.0/rules/data.md",
        "---\nname: data\n---\n\n# data\n",
    )

    _write_json(
        root / "capability-groups/domain/base/1.0.0/group.json",
        {
            "guid": "e" * 32,
            "name": "base",
            "version": "1.0.0",
            "description": "base group",
            "permissions": ["fs"],
            "extends": [],
            "tools": [],
        },
    )
    _write(
        root / "capability-groups/domain/base/1.0.0/rules/base.md",
        "---\nname: base\n---\n\n# base\n",
    )

    for guid, name, version in (
        ("b" * 32, "mcp-tool", "0.1.0"),
        ("d" * 32, "demo-tool", "0.1.0"),
    ):
        _write_json(
            root / f"tools/{name}/{version}/tool.json",
            {
                "schema_version": 1,
                "guid": guid,
                "name": name,
                "tool_name": name,
                "version": version,
                "description": f"{name} description",
                "provider": "mcp",
                "permissions": ["net"],
                "mcp": {"name": name.replace("-", "_"), "type": "remote", "url": "http://example.test/mcp"},
            },
        )

    _write_json(
        root / "plugins/dsh/plugin.json",
        {
            "schema_version": 1,
            "name": "dsh",
            "agent": "dsh",
            "version": "0.4.0",
            "entrypoint": "index.js",
            "capabilities": ["rules", "skills", "commands", "mcp", "agents"],
        },
    )
    _write(root / "plugins/dsh/index.js", "export const apply = () => {}\n")
    return root


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "project"
    root.mkdir()
    return root
