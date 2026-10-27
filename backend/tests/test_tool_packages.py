from __future__ import annotations

import json
from pathlib import Path

import pytest

from deerflow.tools.packages import ToolPackageError, discover_tool_packages, load_tool_package


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _package(root: Path, *, name: str = "demo", version: str = "0.1.0", guid: str = "a" * 32, **extra: object) -> Path:
    package_dir = root / name / version
    manifest = {
        "schema_version": 1,
        "guid": guid,
        "name": name,
        "version": version,
        "description": "Demo tool",
        "provider": "python",
        "entrypoint": "tool.py:build_tool",
        **extra,
    }
    _write(package_dir / "tool.json", json.dumps(manifest))
    _write(package_dir / "tool.py", "def build_tool():\n    return None\n")
    return package_dir


def test_discover_and_load_current_version(tmp_path: Path) -> None:
    _package(tmp_path, version="0.1.0")
    _package(tmp_path, version="0.2.0", guid="b" * 32)

    packages = discover_tool_packages(root=tmp_path)

    assert [package.name for package in packages] == ["demo"]
    assert packages[0].version == "0.2.0"
    assert load_tool_package("demo", root=tmp_path).guid == "b" * 32
    assert load_tool_package("demo", version="0.1.0", root=tmp_path).guid == "a" * 32


def test_malformed_package_is_skipped(tmp_path: Path) -> None:
    _package(tmp_path)
    _write(tmp_path / "broken" / "0.1.0" / "tool.json", "{not json")

    assert [package.name for package in discover_tool_packages(root=tmp_path)] == ["demo"]


def test_unknown_permission_is_rejected(tmp_path: Path) -> None:
    _package(tmp_path, permissions=["root"])

    with pytest.raises(ToolPackageError, match="unknown permission"):
        load_tool_package("demo", root=tmp_path)


def test_missing_provider_fields_are_rejected(tmp_path: Path) -> None:
    _package(tmp_path, provider="mcp")

    with pytest.raises(ToolPackageError, match=r"mcp tools require an mcp block or server \+ tool"):
        load_tool_package("demo", root=tmp_path)


def test_python_requires_entrypoint(tmp_path: Path) -> None:
    _package(tmp_path, entrypoint=None)

    with pytest.raises(ToolPackageError, match="python tools require entrypoint"):
        load_tool_package("demo", root=tmp_path)


def test_tool_ref_is_guid_and_version_pinned(tmp_path: Path) -> None:
    _package(tmp_path)
    package = load_tool_package("demo", root=tmp_path)

    assert package.ref == f"tool:{'a' * 32}@v0.1.0"
