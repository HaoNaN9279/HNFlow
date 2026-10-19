from __future__ import annotations

import json
from pathlib import Path

import pytest

from deerflow.capability_groups import (
    CapabilityGroupError,
    build_capability_contents,
    classify_capability_file,
    discover_capability_groups,
    load_capability_group,
    summarize_markdown,
)
from deerflow.capability_groups import discovery as discovery_module


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _make_group(root: Path, *, name: str = "demo", version: str = "0.1.0", guid: str = "a" * 32) -> Path:
    group_dir = root / name / version
    _write(
        group_dir / "group.json",
        json.dumps({"guid": guid, "name": name, "version": version, "description": "Demo group"}),
    )
    _write(group_dir / "SKILL.md", "---\ndescription: Main group rules\n---\n\n# Rules\n\nBody\n")
    _write(group_dir / "rules" / "style.md", "---\ndescription: Keep styles consistent\n---\n")
    _write(group_dir / "agents" / "helper.md", "# Helper\n\nHelps with tasks.\n")
    _write(group_dir / "skills" / "child" / "SKILL.md", "---\ndescription: Child skill\n---\n")
    _write(group_dir / "scripts" / "run.py", "print('ok')\n")
    return group_dir


def test_summarize_markdown_prefers_frontmatter_description() -> None:
    assert summarize_markdown("---\ndescription: Short summary\n---\n\n# Heading\n\nBody") == "Short summary"


def test_summarize_markdown_falls_back_to_first_paragraph() -> None:
    assert summarize_markdown("\n\n# Heading\n\nThe first paragraph is the summary.\n") == "The first paragraph is the summary."


def test_classify_capability_file_has_no_commands_category() -> None:
    assert classify_capability_file("SKILL.md") == "rules"
    assert classify_capability_file("rules/style.md") == "rules"
    assert classify_capability_file("agents/helper.md") == "agents"
    assert classify_capability_file("skills/child/SKILL.md") == "skills"
    assert classify_capability_file("scripts/run.py") == "tools"
    assert classify_capability_file("commands/build.md") == "other"


def test_build_capability_contents_groups_and_skips_manifest(tmp_path: Path) -> None:
    group_dir = _make_group(tmp_path)
    files = build_capability_contents(group_dir)
    categories = {item.category for item in files}
    assert categories == {"rules", "agents", "skills", "tools"}
    assert all(item.path != "group.json" for item in files)
    assert next(item for item in files if item.path == "rules/style.md").summary == "Keep styles consistent"


def test_discover_and_load_current_version(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _make_group(tmp_path, version="0.1.0")
    _make_group(tmp_path, version="0.2.0", guid="b" * 32)
    monkeypatch.setattr(discovery_module, "_roots", lambda user_id=None: [(tmp_path, "public")])

    groups = discover_capability_groups()
    assert len(groups) == 1
    assert groups[0].version == "0.2.0"
    loaded = load_capability_group("demo")
    assert loaded.guid == "b" * 32
    assert loaded.counts["skills"] == 1


def test_malformed_group_is_skipped(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _make_group(tmp_path)
    broken = tmp_path / "broken" / "0.1.0"
    _write(broken / "group.json", "{not json")
    monkeypatch.setattr(discovery_module, "_roots", lambda user_id=None: [(tmp_path, "public")])

    groups = discover_capability_groups()
    assert [group.name for group in groups] == ["demo"]


def test_missing_group_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(discovery_module, "_roots", lambda user_id=None: [(tmp_path, "public")])
    with pytest.raises(CapabilityGroupError):
        load_capability_group("missing")
