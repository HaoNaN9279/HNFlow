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
    resolve_reveal_target,
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


def test_classify_capability_file_keeps_arbitrary_top_level_directories() -> None:
    assert classify_capability_file("SKILL.md") == "rules"
    assert classify_capability_file("rules/style.md") == "rules"
    assert classify_capability_file("agents/helper.md") == "agents"
    assert classify_capability_file("skills/child/SKILL.md") == "skills"
    assert classify_capability_file("scripts/run.py") == "tools"
    assert classify_capability_file("commands/build.md") == "commands"
    assert classify_capability_file("commands/nested/build.md") == "commands"
    assert classify_capability_file("docs/guide/SKILL.md") == "docs"
    assert classify_capability_file("README.md") == "other"


def test_group_counts_include_dynamic_categories(tmp_path: Path) -> None:
    group_dir = _make_group(tmp_path)
    _write(group_dir / "commands" / "build.md", "# Build\n")
    files = build_capability_contents(group_dir)
    category = next(item.category for item in files if item.path == "commands/build.md")
    assert category == "commands"


def test_build_capability_contents_groups_and_skips_manifest(tmp_path: Path) -> None:
    group_dir = _make_group(tmp_path)
    files = build_capability_contents(group_dir)
    categories = {item.category for item in files}
    assert categories == {"rules", "agents", "skills", "tools"}
    assert all(item.path != "group.json" for item in files)
    assert next(item for item in files if item.path == "rules/style.md").summary == "Keep styles consistent"


def test_discover_and_load_current_version(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _make_group(tmp_path, version="0.1.0")
    _make_group(tmp_path, version="0.2.0")
    monkeypatch.setattr(discovery_module, "_roots", lambda user_id=None, project_roots=(): [discovery_module._RootSpec(path=tmp_path, source="public", project_id=None, root_id=None, priority=0)])

    groups = discover_capability_groups()
    assert len(groups) == 1
    assert groups[0].version == "0.2.0"
    loaded = load_capability_group("demo")
    assert loaded.guid == "a" * 32
    assert loaded.counts["skills"] == 1


def test_detail_lists_dynamic_categories_after_builtins(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    group_dir = _make_group(tmp_path)
    _write(group_dir / "commands" / "nested" / "build.md", "# Build\n")
    monkeypatch.setattr(discovery_module, "_roots", lambda user_id=None, project_roots=(): [discovery_module._RootSpec(path=tmp_path, source="public", project_id=None, root_id=None, priority=0)])

    group = load_capability_group("demo")
    detail = group.detail_dict()
    categories = detail["categories"]
    assert isinstance(categories, list)
    ids = [item["id"] for item in categories]
    assert ids[-1] == "commands"
    assert group.counts["commands"] == 1


def test_resolve_reveal_target_supports_group_root(tmp_path: Path) -> None:
    root = tmp_path / "group"
    _write(root / "rules" / "style.md", "# Style\n")

    assert resolve_reveal_target(root, ".") == root.resolve()
    assert resolve_reveal_target(root, "rules/style.md") == (root / "rules" / "style.md").resolve()
    with pytest.raises(ValueError):
        resolve_reveal_target(root, "../outside.md")


def test_malformed_group_is_skipped(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _make_group(tmp_path)
    broken = tmp_path / "broken" / "0.1.0"
    _write(broken / "group.json", "{not json")
    monkeypatch.setattr(discovery_module, "_roots", lambda user_id=None, project_roots=(): [discovery_module._RootSpec(path=tmp_path, source="public", project_id=None, root_id=None, priority=0)])

    groups = discover_capability_groups()
    assert [group.name for group in groups] == ["demo"]


def test_missing_group_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(discovery_module, "_roots", lambda user_id=None, project_roots=(): [discovery_module._RootSpec(path=tmp_path, source="public", project_id=None, root_id=None, priority=0)])
    with pytest.raises(CapabilityGroupError):
        load_capability_group("missing")


def test_group_parses_tool_references_and_permission_overrides(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    group_dir = _make_group(tmp_path)
    manifest = json.loads((group_dir / "group.json").read_text(encoding="utf-8"))
    manifest["tools"] = ["builtin:read_file", "mcp:github:search", "builtin:read_file"]
    manifest["tool_permissions"] = {"mcp:github:search": ["net"]}
    (group_dir / "group.json").write_text(json.dumps(manifest), encoding="utf-8")
    monkeypatch.setattr(discovery_module, "_roots", lambda user_id=None, project_roots=(): [discovery_module._RootSpec(path=tmp_path, source="public", project_id=None, root_id=None, priority=0)])

    group = load_capability_group("demo")

    assert group.tools == ("builtin:read_file", "mcp:github:search")
    assert group.tool_permissions == {"mcp:github:search": ("net",)}
    assert group.summary_dict()["tools"] == ["builtin:read_file", "mcp:github:search"]


def test_validate_capability_tool_refs_checks_custom_packages(tmp_path: Path) -> None:
    from deerflow.workflow.schema import Node, NodeType, WorkflowDefinition, validate_capability_tool_refs

    repo = tmp_path / "repo"
    group_dir = repo / "capability-groups" / "demo" / "0.1.0"
    group_dir.mkdir(parents=True)
    (group_dir / "group.json").write_text(
        json.dumps(
            {
                "guid": "b" * 32,
                "name": "demo",
                "version": "0.1.0",
                "description": "demo",
                "permissions": ["fs"],
                "tools": ["tool:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@v0.1.0", "builtin:read_file"],
            }
        ),
        encoding="utf-8",
    )
    definition = WorkflowDefinition(
        id="wf",
        name="wf",
        nodes=[Node(id="n", type=NodeType.AI_LLM_AGENT, capability_groups=["demo"])],
        edges=[],
    )

    errors = validate_capability_tool_refs(definition, repository=repo)

    assert len(errors) == 1
    assert "unavailable tool package" in errors[0]


def test_group_rejects_malformed_tool_permissions(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    group_dir = _make_group(tmp_path)
    manifest = json.loads((group_dir / "group.json").read_text(encoding="utf-8"))
    manifest["tool_permissions"] = {"mcp:github:search": "net"}
    (group_dir / "group.json").write_text(json.dumps(manifest), encoding="utf-8")
    monkeypatch.setattr(discovery_module, "_roots", lambda user_id=None, project_roots=(): [discovery_module._RootSpec(path=tmp_path, source="public", project_id=None, root_id=None, priority=0)])

    groups = discover_capability_groups()

    assert groups == []
