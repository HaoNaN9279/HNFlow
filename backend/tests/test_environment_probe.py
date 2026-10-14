"""N11 S2 — probe execution (the I/O half).

Every probe target is built from ``sys.executable`` and a tiny inline program, so
these tests pass on any machine without Blender/Unity/Photoshop installed, on
Windows and POSIX alike.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from deerflow.environment.probe import (
    clear_probe_cache,
    probe_all,
    probe_all_cached,
    resolve_executable,
    run_probe,
)
from deerflow.environment.spec import PROBE_MISMATCH, PROBE_MISSING, PROBE_OK, PROBE_UNKNOWN, SOURCE_CACHE, SOURCE_LIVE, ProbeKind, RequirementSpec

MISSING_COMMAND = "definitely-not-installed-xyz-12345"


def _python_version_spec(program: str, *, expect: str | None = None, name: str = "python") -> RequirementSpec:
    """A version spec whose command is the running interpreter (cross-platform)."""
    return RequirementSpec(kind=ProbeKind.VERSION, name=name, command=[sys.executable, "-c", program], expect=expect)


@pytest.fixture(autouse=True)
def _clear_cache() -> None:
    clear_probe_cache()


# ── executable / path / plugin ────────────────────────────────────────────────


class TestResolveExecutable:
    def test_bare_name_resolves_on_path(self) -> None:
        expected = resolve_executable(Path(sys.executable).name)
        assert expected is not None

    def test_absolute_path_resolves_when_present(self) -> None:
        assert resolve_executable(sys.executable) == sys.executable

    def test_missing_name_and_path_resolve_to_none(self) -> None:
        assert resolve_executable(MISSING_COMMAND) is None
        assert resolve_executable(str(Path(sys.executable).parent / "definitely-missing-xyz-12345")) is None

    def test_blank_name_is_none(self) -> None:
        assert resolve_executable("   ") is None


class TestExistenceKinds:
    def test_executable_present_and_absent(self) -> None:
        present = run_probe(RequirementSpec(kind=ProbeKind.EXECUTABLE, name=sys.executable))
        assert present.outcome == PROBE_OK
        assert present.observed == sys.executable

        absent = run_probe(RequirementSpec(kind=ProbeKind.EXECUTABLE, name=MISSING_COMMAND))
        assert absent.outcome == PROBE_MISSING

    def test_path_present_and_absent(self, tmp_path: Path) -> None:
        existing = tmp_path / "plugin-dir"
        existing.mkdir()
        present = run_probe(RequirementSpec(kind=ProbeKind.PATH, name=str(existing)))
        assert present.outcome == PROBE_OK

        absent = run_probe(RequirementSpec(kind=ProbeKind.PATH, name=str(tmp_path / "nope")))
        assert absent.outcome == PROBE_MISSING

    def test_path_expands_environment_variables(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        target = tmp_path / "blender-plugins"
        target.mkdir()
        monkeypatch.setenv("HNFLOW_TEST_PLUGIN_DIR", str(target))
        result = run_probe(RequirementSpec(kind=ProbeKind.PATH, name="$HNFLOW_TEST_PLUGIN_DIR"))
        assert result.outcome == PROBE_OK
        assert result.observed == str(target)

    def test_plugin_resolves_relative_to_the_application_working_dir(self, tmp_path: Path) -> None:
        """The one real difference from `path`: a relative plugin name is app-scoped."""
        app_dir = tmp_path / "Blender"
        (app_dir / "addons").mkdir(parents=True)
        spec = RequirementSpec(kind=ProbeKind.PLUGIN, name="addons")

        assert run_probe(spec, working_dir=app_dir).outcome == PROBE_OK
        # Same spec, no working dir: resolved against the process cwd, which does
        # not contain "addons" — the requirement is about the app, not the cwd.
        assert run_probe(spec).outcome == PROBE_MISSING

    def test_path_is_cwd_scoped_not_working_dir_scoped(self, tmp_path: Path) -> None:
        """`path` is an environment fact, so an app working_dir must not leak into it."""
        app_dir = tmp_path / "app"
        app_dir.mkdir()
        spec = RequirementSpec(kind=ProbeKind.PATH, name=".")
        assert run_probe(spec, working_dir=app_dir).outcome == PROBE_OK  # "." exists everywhere


# ── version / runtime ─────────────────────────────────────────────────────────


class TestVersionProbe:
    def test_reads_a_version_from_stdout(self) -> None:
        result = run_probe(_python_version_spec("print('4.2.1')"))
        assert result.outcome == PROBE_OK
        assert result.observed == "4.2.1"
        assert result.source == SOURCE_LIVE

    def test_reads_a_version_from_a_banner(self) -> None:
        result = run_probe(_python_version_spec("print('Blender 4.2.1 LTS')"))
        assert result.outcome == PROBE_OK
        assert result.observed == "4.2.1"

    def test_reads_a_version_from_stderr(self) -> None:
        result = run_probe(_python_version_spec("import sys; print('3.11.4', file=sys.stderr)"))
        assert result.outcome == PROBE_OK
        assert result.observed == "3.11.4"

    def test_satisfied_expectation_is_ok(self) -> None:
        result = run_probe(_python_version_spec("print('3.12.1')", expect=">=3.11,<4"))
        assert result.outcome == PROBE_OK

    def test_violated_expectation_is_mismatch(self) -> None:
        result = run_probe(_python_version_spec("print('3.12.1')", expect=">=4"))
        assert result.outcome == PROBE_MISMATCH
        assert "3.12.1" in result.observed

    def test_missing_executable_is_missing(self) -> None:
        spec = RequirementSpec(kind=ProbeKind.VERSION, name=MISSING_COMMAND)
        assert run_probe(spec).outcome == PROBE_MISSING

    def test_nonzero_exit_is_unknown_and_not_trusted_as_a_version(self) -> None:
        """A command that failed did not answer the question, even if it printed a version."""
        result = run_probe(_python_version_spec("import sys; print('4.2.1'); sys.exit(3)"))
        assert result.outcome == PROBE_UNKNOWN
        assert result.failed is False
        assert "exit code 3" in result.detail

    def test_no_version_like_output_is_unknown(self) -> None:
        result = run_probe(_python_version_spec("print('hello')"))
        assert result.outcome == PROBE_UNKNOWN
        assert "no version-like text" in result.detail

    def test_timeout_is_unknown(self) -> None:
        result = run_probe(_python_version_spec("import time; time.sleep(10)"), timeout=0.5)
        assert result.outcome == PROBE_UNKNOWN
        assert "timed out" in result.detail

    def test_unparsable_comparison_is_unknown(self) -> None:
        result = run_probe(_python_version_spec("print('3.12.1')", expect=">="))
        assert result.outcome == PROBE_UNKNOWN

    def test_runtime_kind_behaves_like_version(self) -> None:
        spec = RequirementSpec(kind=ProbeKind.RUNTIME, name="python", command=[sys.executable, "-c", "print('3.12.1')"], expect="^3.11")
        assert run_probe(spec).outcome == PROBE_OK

    def test_default_command_is_name_dash_dash_version(self) -> None:
        """A bare requirement uses `<name> --version`; python's own flag is `-V`."""
        spec = RequirementSpec(kind=ProbeKind.RUNTIME, name=sys.executable, command=[sys.executable, "--version"])
        assert run_probe(spec).outcome == PROBE_OK

    def test_working_dir_is_used_for_the_command(self, tmp_path: Path) -> None:
        spec = _python_version_spec("import pathlib; print('1.2.3' if pathlib.Path('marker.txt').exists() else 'nope')")
        (tmp_path / "marker.txt").write_text("x", encoding="utf-8")
        assert run_probe(spec, working_dir=tmp_path).outcome == PROBE_OK
        assert run_probe(spec).outcome == PROBE_UNKNOWN


class TestRunProbeNeverRaises:
    def test_hostile_name_does_not_raise(self) -> None:
        result = run_probe(RequirementSpec(kind=ProbeKind.PATH, name="bad\x00name"))
        assert result.outcome in {PROBE_MISSING, PROBE_UNKNOWN}

    def test_command_that_cannot_be_executed_is_unknown(self, tmp_path: Path) -> None:
        """An existing but non-executable target must not read as 'missing app'."""
        bogus = tmp_path / "not-executable"
        bogus.mkdir()  # a directory where a file is expected: exec fails
        spec = RequirementSpec(kind=ProbeKind.VERSION, name=str(bogus))
        result = run_probe(spec)
        assert result.outcome == PROBE_UNKNOWN


# ── batching and caching ──────────────────────────────────────────────────────


class TestProbeAllAndCache:
    def test_probe_all_preserves_order(self) -> None:
        specs = [
            RequirementSpec(kind=ProbeKind.EXECUTABLE, name=sys.executable),
            RequirementSpec(kind=ProbeKind.EXECUTABLE, name=MISSING_COMMAND),
        ]
        results = probe_all(specs)
        assert [result.outcome for result in results] == [PROBE_OK, PROBE_MISSING]

    def test_cache_serves_the_second_call_and_marks_the_source(self) -> None:
        spec = RequirementSpec(kind=ProbeKind.EXECUTABLE, name=sys.executable)
        first = probe_all_cached([spec], namespace="t")
        assert first[0].source == SOURCE_LIVE

        second = probe_all_cached([spec], namespace="t")
        assert second[0].source == SOURCE_CACHE
        assert second[0].outcome == first[0].outcome

    def test_force_bypasses_the_cache(self) -> None:
        spec = RequirementSpec(kind=ProbeKind.EXECUTABLE, name=sys.executable)
        probe_all_cached([spec], namespace="t")
        assert probe_all_cached([spec], namespace="t", force=True)[0].source == SOURCE_LIVE

    def test_expired_cache_reprobes(self) -> None:
        spec = RequirementSpec(kind=ProbeKind.EXECUTABLE, name=sys.executable)
        probe_all_cached([spec], namespace="t")
        assert probe_all_cached([spec], namespace="t", ttl=0.0)[0].source == SOURCE_LIVE

    def test_different_working_dirs_do_not_share_a_cache_entry(self, tmp_path: Path) -> None:
        spec = RequirementSpec(kind=ProbeKind.PLUGIN, name="addons")
        probe_all_cached([spec], namespace="t", working_dir=tmp_path)
        other = tmp_path / "other"
        other.mkdir()
        assert probe_all_cached([spec], namespace="t", working_dir=other)[0].source == SOURCE_LIVE

    def test_empty_spec_list_short_circuits(self) -> None:
        assert probe_all_cached([]) == ()
