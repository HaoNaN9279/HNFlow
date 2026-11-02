"""N11 S6 — the ``python -m deerflow.environment`` CLI.

Exit codes carry the meaning: ``0`` nothing required is broken, ``1`` a required
item is definitively broken, ``2`` the check itself could not run.  Renderer and
exit-code logic are tested against canned reports; the collector is tested against
a redirected ``DEER_FLOW_HOME`` and a stubbed app config.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from deerflow.environment import __main__ as cli


def _report(*, overall: str = "ok", problems: list[str] | None = None, enabled: bool = True) -> dict:
    return {
        "enabled": enabled,
        "overall": overall,
        "require_on_load": False,
        "requirements": {"enabled": enabled, "overall": overall, "require_on_load": False, "sources": []},
        "data_dirs": [
            {
                "name": "base",
                "path": "/home/.deer-flow",
                "purpose": "Application data root",
                "scope": "global",
                "required": True,
                "exists": overall != "missing",
                "writable": True if overall != "missing" else None,
                "ok": overall != "missing",
                "problem": "" if overall != "missing" else "does not exist",
            }
        ],
        "blocking_problems": problems or [],
    }


class TestRender:
    def test_prints_directory_names_purposes_and_state(self) -> None:
        text = cli._render(_report())
        assert "overall: ok" in text
        assert "data directories:" in text
        assert "base (required, global): present" in text
        assert "/home/.deer-flow" in text
        assert "Application data root" in text

    def test_marks_problems_and_lists_them(self) -> None:
        text = cli._render(_report(overall="missing", problems=["data directory 'base' (/home/.deer-flow): does not exist"]))
        assert "[FAIL]" in text
        assert "blocking problems:" in text
        assert "does not exist" in text

    def test_reports_no_declared_requirements_plainly(self) -> None:
        assert "requirements: none declared" in cli._render(_report())

    def test_lists_requirement_results_when_present(self) -> None:
        report = _report()
        report["requirements"]["sources"] = [
            {
                "source": "app:blender",
                "label": "Blender",
                "overall": "missing",
                "results": [{"kind": "version", "name": "blender", "expect": ">=4", "optional": False, "outcome": "missing", "observed": "", "detail": "command not found", "source": "live"}],
            }
        ]
        text = cli._render(report)
        assert "app:blender [missing]" in text
        assert "version blender expect >=4" in text
        assert "command not found" in text


class TestMain:
    def test_json_report_exits_zero_when_nothing_required_is_broken(self, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
        monkeypatch.setattr(cli, "_collect", lambda *, force: _report())
        assert cli.main(["--json"]) == 0
        payload = json.loads(capsys.readouterr().out)
        assert payload["overall"] == "ok"

    def test_missing_exits_one(self, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
        monkeypatch.setattr(cli, "_collect", lambda *, force: _report(overall="missing", problems=["nope"]))
        assert cli.main([]) == 1
        assert "blocking problems:" in capsys.readouterr().out

    def test_degraded_exits_zero(self, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
        monkeypatch.setattr(cli, "_collect", lambda *, force: _report(overall="degraded"))
        assert cli.main([]) == 0
        capsys.readouterr()

    def test_a_broken_check_exits_two_without_traceback(self, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
        def boom(*, force: bool) -> dict:  # noqa: ARG001 - mirrors the real signature
            raise RuntimeError("config unreadable")

        monkeypatch.setattr(cli, "_collect", boom)
        assert cli.main([]) == 2
        captured = capsys.readouterr()
        assert "could not run" in captured.err
        assert "RuntimeError" in captured.err
        assert captured.out == ""

    def test_force_is_forwarded(self, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
        seen: list[bool] = []

        def spy(*, force: bool) -> dict:
            seen.append(force)
            return _report()

        monkeypatch.setattr(cli, "_collect", spy)
        cli.main(["--force"])
        cli.main([])
        capsys.readouterr()
        assert seen == [True, False]


class TestCollect:
    def test_collects_the_redirected_layout_and_declared_requirements(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        from deerflow.config.apps_config import AppDefinition, AppsConfig, EnvironmentConfig
        from deerflow.config.paths import Paths

        home = tmp_path / "home"
        paths = Paths(base_dir=home)
        paths.ensure_data_dirs()

        apps_config = AppsConfig(
            enabled=True,
            definitions={
                "demo": AppDefinition(
                    driver="mock",
                    description="demo",
                    requires=[{"kind": "executable", "name": sys.executable}],  # type: ignore[list-item]
                )
            },
            environment=EnvironmentConfig(),
        )
        config = type(
            "C",
            (),
            {
                "apps": apps_config,
                "memory": type("M", (), {"enabled": False})(),
                "database": type("D", (), {"backend": "memory"})(),
            },
        )()

        monkeypatch.setattr("deerflow.config.app_config.get_app_config", lambda: config)
        monkeypatch.setattr("deerflow.config.paths.get_paths", lambda: paths)
        monkeypatch.setattr(cli, "_load_skills", lambda config: [])

        report = cli._collect(force=True)
        assert report["overall"] == "ok"
        assert all(entry["ok"] for entry in report["data_dirs"] if entry["required"])
        assert report["requirements"]["sources"][0]["source"] == "app:demo"
        assert report["requirements"]["sources"][0]["results"][0]["outcome"] == "ok"

    def test_a_broken_skill_tree_does_not_hide_the_directory_report(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        from deerflow.config.apps_config import AppsConfig
        from deerflow.config.paths import Paths

        paths = Paths(base_dir=tmp_path / "home")
        paths.ensure_data_dirs()
        config = type(
            "C",
            (),
            {
                "apps": AppsConfig(),
                "memory": type("M", (), {"enabled": False})(),
                "database": type("D", (), {"backend": "memory"})(),
            },
        )()

        def boom(_config: object) -> list:
            raise RuntimeError("skill tree unreadable")

        monkeypatch.setattr("deerflow.config.app_config.get_app_config", lambda: config)
        monkeypatch.setattr("deerflow.config.paths.get_paths", lambda: paths)
        monkeypatch.setattr(cli, "_load_skills", boom)

        report = cli._collect(force=False)
        assert report["data_dirs"]
        assert report["overall"] == "ok"
