"""CLI smoke tests."""

from __future__ import annotations

import json
from pathlib import Path

from hnflow_stack.cli import main
from hnflow_stack.repo import global_config_path


def test_cli_list_and_info(repo: Path, capsys) -> None:
    assert main(["--repo", str(repo), "list"]) == 0
    output = capsys.readouterr().out
    assert "data@1.0.0" in output
    assert main(["--repo", str(repo), "info", "data"]) == 0
    assert "extends: base" in capsys.readouterr().out


def test_cli_init_activate_status(
    repo: Path, project: Path, isolated_home: Path, capsys
) -> None:
    base = ["--repo", str(repo), "--project", str(project)]
    assert main([*base, "init", "--core", "core@0.1.0"]) == 0
    assert global_config_path().is_relative_to(isolated_home)
    assert main([*base, "activate", "data"]) == 0
    assert main([*base, "status"]) == 0
    output = capsys.readouterr().out
    assert "data@1.0.0" in output
    assert main([*base, "sync"]) == 0
    lock = json.loads((project / ".hnflow" / "lock.json").read_text(encoding="utf-8"))
    assert lock["fingerprint"]


def test_cli_init_survives_unwritable_global_config(
    repo: Path, project: Path, isolated_home: Path, capsys, monkeypatch
) -> None:
    import hnflow_stack.cli as cli

    def refuse(_data: object) -> None:
        raise PermissionError("denied")

    monkeypatch.setattr(cli, "write_global_config", refuse)
    base = ["--repo", str(repo), "--project", str(project)]
    assert main([*base, "init", "--core", "core@0.1.0"]) == 0
    captured = capsys.readouterr()
    assert (project / ".hnflow" / "stack.json").is_file()
    assert "warning: cannot update" in captured.err


def test_cli_resolve_json(repo: Path, project: Path, capsysbinary) -> None:
    base = ["--repo", str(repo), "--project", str(project)]
    assert main([*base, "init", "--core", "core@0.1.0"]) == 0
    assert main([*base, "activate", "data"]) == 0
    capsysbinary.readouterr()
    assert main(["--repo", str(repo), "resolve", "--json", "--project", str(project)]) == 0
    output = capsysbinary.readouterr().out
    data = json.loads(output.decode("utf-8"))
    assert data["schema_version"] == 2
    assert data["active"] is True
    assert data["mode"] == "project"
    assert [group["name"] for group in data["groups"]] == ["base", "data"]
    assert data["fingerprint"]


def test_cli_resolve_without_stack(
    repo: Path, project: Path, capsysbinary
) -> None:
    assert main(["--repo", str(repo), "resolve", "--json", "--project", str(project)]) == 0
    data = json.loads(capsysbinary.readouterr().out.decode("utf-8"))
    assert data["active"] is False
    assert data["mode"] == "project"
    assert data["core"] is None


def test_cli_resolve_capabilities_mode_loads_core_without_stack(
    repo: Path, project: Path, capsysbinary
) -> None:
    assert (
        main(
            [
                "--repo",
                str(repo),
                "resolve",
                "--json",
                "--mode",
                "capabilities",
                "--project",
                str(project),
            ]
        )
        == 0
    )
    data = json.loads(capsysbinary.readouterr().out.decode("utf-8"))
    assert data["active"] is True
    assert data["mode"] == "capabilities"
    assert data["core"]["name"] == "core"
    assert data["agents"]["Helper"]["group"] == "core"
    assert data["skills"][0]["name"] == "core-skill"


def test_cli_resolve_invalid_stack(repo: Path, project: Path, capsys) -> None:
    stack = project / ".hnflow" / "stack.json"
    stack.parent.mkdir(parents=True)
    stack.write_text("{", encoding="utf-8")
    assert main(["--repo", str(repo), "resolve", "--json", "--project", str(project)]) == 1
    assert "invalid JSON" in capsys.readouterr().err

def test_cli_resolve_accepts_utf8_bom(repo: Path, project: Path, capsysbinary) -> None:
    stack = project / ".hnflow" / "stack.json"
    stack.parent.mkdir(parents=True)
    stack.write_text(
        "\ufeff" + json.dumps({"schema_version": 2, "groups": []}),
        encoding="utf-8",
    )
    assert main(["--repo", str(repo), "resolve", "--json", "--project", str(project)]) == 0
    data = json.loads(capsysbinary.readouterr().out.decode("utf-8"))
    assert data["active"] is True
    assert data["core"] is None
