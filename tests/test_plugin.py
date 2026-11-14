"""Plugin adapter discovery and status tests."""

from __future__ import annotations

from pathlib import Path

from hnflow_stack.plugin import discover_plugins, status


def test_discovers_the_dsh_adapter(repo: Path) -> None:
    manifests = discover_plugins(repo)
    assert [manifest["agent"] for manifest in manifests] == ["dsh"]
    assert manifests[0]["version"] == "0.4.0"


def test_status_reports_a_dsh_manifest_without_copy_install(repo: Path) -> None:
    data = status(repo, "dsh")
    assert data["agent"] == "dsh"
    assert data["version"] == "0.4.0"
    assert data["target"] == ""
    assert data["installed"] is False
    assert data["skills_target"] == ""
    assert data["skills_installed"] is False
