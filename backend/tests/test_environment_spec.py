"""N11 S1 — requirement specs, version comparison, and the probe decision table.

Everything here is pure: no filesystem, no subprocess, no config singleton.  The
I/O half is covered by ``tests/test_environment_probe.py`` (S2).
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from deerflow.environment.evaluate import Observation, build_report, evaluate_probe, required_failures, summarize
from deerflow.environment.spec import (
    OVERALL_DEGRADED,
    OVERALL_MISSING,
    OVERALL_OK,
    PROBE_MISMATCH,
    PROBE_MISSING,
    PROBE_OK,
    PROBE_UNKNOWN,
    ProbeKind,
    ProbeResult,
    RequirementReport,
    RequirementSpec,
)
from deerflow.environment.version import compare_versions, extract_version, parse_version, version_satisfies

# ── RequirementSpec validation ────────────────────────────────────────────────


class TestRequirementSpec:
    def test_minimal_existence_spec(self) -> None:
        spec = RequirementSpec(kind=ProbeKind.EXECUTABLE, name="blender")
        assert spec.kind is ProbeKind.EXECUTABLE
        assert spec.command is None
        assert spec.expect is None
        assert spec.optional is False
        assert spec.resolved_command() is None

    def test_name_is_trimmed_and_blank_rejected(self) -> None:
        assert RequirementSpec(kind=ProbeKind.PATH, name="  /opt/ps  ").name == "/opt/ps"
        with pytest.raises(ValidationError):
            RequirementSpec(kind=ProbeKind.PATH, name="   ")

    def test_command_and_expect_rejected_on_existence_kinds(self) -> None:
        """A `path` spec with a command is a mistake about intent, not an extra."""
        with pytest.raises(ValidationError, match="command is only meaningful"):
            RequirementSpec(kind=ProbeKind.PATH, name="/opt/x", command=["x", "--version"])
        with pytest.raises(ValidationError, match="expect is only meaningful"):
            RequirementSpec(kind=ProbeKind.PLUGIN, name="addon", expect=">=1")

    def test_unknown_kind_rejected(self) -> None:
        with pytest.raises(ValidationError):
            RequirementSpec(kind="telepathy", name="x")  # type: ignore[arg-type]

    def test_extra_fields_rejected(self) -> None:
        with pytest.raises(ValidationError):
            RequirementSpec(kind=ProbeKind.PATH, name="/opt/x", mandatory=True)  # type: ignore[call-arg]

    def test_command_tokens_validated(self) -> None:
        assert RequirementSpec(kind=ProbeKind.VERSION, name="blender", command=["blender", "-v"]).command == ["blender", "-v"]
        with pytest.raises(ValidationError):
            RequirementSpec(kind=ProbeKind.VERSION, name="blender", command=[])
        with pytest.raises(ValidationError):
            RequirementSpec(kind=ProbeKind.VERSION, name="blender", command=["blender", "  "])
        with pytest.raises(ValidationError):
            RequirementSpec(kind=ProbeKind.VERSION, name="blender", command=[1])  # type: ignore[list-item]

    def test_expect_blank_normalizes_to_any_version(self) -> None:
        spec = RequirementSpec(kind=ProbeKind.VERSION, name="blender", expect="   ")
        assert spec.expect is None

    def test_resolved_command_defaults_to_dash_dash_version(self) -> None:
        assert RequirementSpec(kind=ProbeKind.VERSION, name="blender").resolved_command() == ["blender", "--version"]
        assert RequirementSpec(kind=ProbeKind.RUNTIME, name="python", command=["py", "-3", "--version"]).resolved_command() == ["py", "-3", "--version"]
        assert RequirementSpec(kind=ProbeKind.EXECUTABLE, name="blender").resolved_command() is None

    def test_describe_mentions_expect_and_optional(self) -> None:
        assert RequirementSpec(kind=ProbeKind.VERSION, name="blender", expect=">=4").describe() == "version:blender >=4"
        assert RequirementSpec(kind=ProbeKind.EXECUTABLE, name="uv", optional=True).describe() == "executable:uv (optional)"


class TestProbeResultAndReport:
    def test_result_rejects_unknown_outcome(self) -> None:
        spec = RequirementSpec(kind=ProbeKind.EXECUTABLE, name="x")
        with pytest.raises(ValueError):
            ProbeResult(spec=spec, outcome="maybe")

    def test_optional_failure_is_not_a_required_failure(self) -> None:
        report = RequirementReport(
            source="app:blender",
            label="Blender",
            results=(
                ProbeResult(spec=RequirementSpec(kind=ProbeKind.EXECUTABLE, name="blender"), outcome=PROBE_OK),
                ProbeResult(spec=RequirementSpec(kind=ProbeKind.EXECUTABLE, name="uv", optional=True), outcome=PROBE_MISSING),
            ),
        )
        assert report.failures == ()
        assert len(report.optional_failures) == 1
        assert report.overall == OVERALL_DEGRADED

    def test_unknown_is_degraded_not_missing(self) -> None:
        report = RequirementReport(
            source="app:ps",
            label="Photoshop",
            results=(ProbeResult(spec=RequirementSpec(kind=ProbeKind.VERSION, name="ps"), outcome=PROBE_UNKNOWN),),
        )
        assert report.overall == OVERALL_DEGRADED
        assert report.unknowns and report.failures == ()

    def test_report_dict_shape(self) -> None:
        report = build_report(
            "skill:cad-export",
            "cad-export",
            [(RequirementSpec(kind=ProbeKind.EXECUTABLE, name="blender"), Observation(found=True, path="/usr/bin/blender"))],
        )
        payload = report.to_dict()
        assert payload["source"] == "skill:cad-export"
        assert payload["overall"] == OVERALL_OK
        assert payload["results"] == [{"kind": "executable", "name": "blender", "expect": None, "optional": False, "outcome": "ok", "observed": "/usr/bin/blender", "detail": "", "source": "live"}]


# ── version parsing / comparison ──────────────────────────────────────────────


class TestParseVersion:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("4.2.1", (4, 2, 1)),
            ("v4.2.1", (4, 2, 1)),
            ("  4.2.1  ", (4, 2, 1)),
            ("4", (4,)),
            ("4.2.1 LTS", (4, 2, 1)),
            ("2024.10", (2024, 10)),
        ],
    )
    def test_parses_leading_version(self, text: str, expected: tuple[int, ...]) -> None:
        assert parse_version(text) == expected

    @pytest.mark.parametrize("text", ["", "  ", "not installed", "Blender 4.2", "v", "x.y.z", None, 42, True])
    def test_rejects_non_version_text(self, text: object) -> None:
        assert parse_version(text) is None

    def test_accepts_component_tuples(self) -> None:
        assert parse_version((4, 2)) == (4, 2)
        assert parse_version([]) is None
        assert parse_version((1, -1)) is None
        assert parse_version((1, True)) is None

    def test_extract_version_finds_first_token_in_a_banner(self) -> None:
        assert extract_version("Blender 4.2.1\nbuild abc") == "4.2.1"
        assert extract_version("Python 3.12.1") == "3.12.1"
        assert extract_version("no version here") is None
        assert extract_version(None) is None

    def test_compare_pads_shorter_versions(self) -> None:
        assert compare_versions((4, 2), (4, 2, 0)) == 0
        assert compare_versions((4, 10), (4, 9)) == 1
        assert compare_versions((4,), (5,)) == -1


class TestVersionSatisfies:
    @pytest.mark.parametrize(
        ("observed", "constraint", "expected"),
        [
            ("4.2.1", None, True),
            ("4.2.1", "", True),
            ("4.2.1", "*", True),
            ("4.2.1", ">=4", True),
            ("4.2.1", ">=4.2", True),
            ("4.2.1", ">4.2", True),
            ("4.2.1", ">4.2.1", False),
            ("4.2.1", "<=4.2.1", True),
            ("4.2.1", "<4.2.1", False),
            ("4.2.1", "==4.2.1", True),
            ("4.2.1", "=4.2", False),
            ("4.2.1", "=4.2.1", True),
            ("4.2.1", "==4.2", False),
            ("4.2.1", "!=4.2", True),
            ("4.2.1", "!=4.2.1", False),
            ("4.2.1", ">=4.0,<5", True),
            ("4.2.1", ">=4.0,<4", False),
            ("5.1", ">=4.0,<5", False),
            # caret pins the leftmost non-zero component
            ("4.9.9", "^4.2.1", True),
            ("5.0.0", "^4.2.1", False),
            ("0.2.9", "^0.2.1", True),
            ("0.3.0", "^0.2.1", False),
            ("0.0.3", "^0.0.3", True),
            ("0.0.4", "^0.0.3", False),
            # tilde pins the minor component
            ("4.2.9", "~4.2.1", True),
            ("4.3.0", "~4.2.1", False),
            ("4.9", "~4", True),
            ("5.0", "~4", False),
            # comparison must be numeric, not lexicographic
            ("4.10.0", ">=4.9", True),
        ],
    )
    def test_constraint_table(self, observed: str, constraint: str | None, expected: bool) -> None:
        assert version_satisfies(observed, constraint) is expected

    @pytest.mark.parametrize(
        ("observed", "constraint"),
        [
            ("not installed", ">=4"),
            ("", ">=4"),
            (None, ">=4"),
            ("4.2.1", ">="),
            ("4.2.1", "4..2"),
            ("4.2.1", ">=4,"),
            ("4.2.1", "~="),
            ("4.2.1", "foo"),
            ("4.2.1", 42),
        ],
    )
    def test_unparsable_sides_answer_unknown(self, observed: object, constraint: object) -> None:
        """A typo must surface as unknown, never as a silent pass or a false failure."""
        assert version_satisfies(observed, constraint) is None

    def test_partially_broken_conjunction_is_unknown(self) -> None:
        assert version_satisfies("4.2.1", ">=4,bogus") is None


# ── decision table ────────────────────────────────────────────────────────────


class TestEvaluateExistenceKinds:
    @pytest.mark.parametrize("kind", [ProbeKind.EXECUTABLE, ProbeKind.PATH, ProbeKind.PLUGIN])
    def test_present_is_ok(self, kind: ProbeKind) -> None:
        spec = RequirementSpec(kind=kind, name="thing")
        result = evaluate_probe(spec, Observation(found=True, path="/resolved/thing"))
        assert result.outcome == PROBE_OK
        assert result.observed == "/resolved/thing"

    @pytest.mark.parametrize("kind", [ProbeKind.EXECUTABLE, ProbeKind.PATH, ProbeKind.PLUGIN])
    def test_absent_is_missing(self, kind: ProbeKind) -> None:
        result = evaluate_probe(RequirementSpec(kind=kind, name="thing"), Observation(found=False))
        assert result.outcome == PROBE_MISSING
        assert result.failed is True

    @pytest.mark.parametrize("kind", [ProbeKind.EXECUTABLE, ProbeKind.PATH, ProbeKind.PLUGIN])
    def test_uncheckable_is_unknown(self, kind: ProbeKind) -> None:
        result = evaluate_probe(RequirementSpec(kind=kind, name="thing"), Observation.unknown("permission denied"))
        assert result.outcome == PROBE_UNKNOWN
        assert result.failed is False
        assert result.detail == "permission denied"


class TestEvaluateCommandKinds:
    @pytest.mark.parametrize("kind", [ProbeKind.VERSION, ProbeKind.RUNTIME])
    def test_missing_executable_is_missing(self, kind: ProbeKind) -> None:
        result = evaluate_probe(RequirementSpec(kind=kind, name="blender"), Observation(found=False))
        assert result.outcome == PROBE_MISSING

    @pytest.mark.parametrize("kind", [ProbeKind.VERSION, ProbeKind.RUNTIME])
    def test_no_version_readable_is_unknown_not_missing(self, kind: ProbeKind) -> None:
        """A missing *version command* is not a missing application."""
        result = evaluate_probe(RequirementSpec(kind=kind, name="blender"), Observation(found=True, version=None))
        assert result.outcome == PROBE_UNKNOWN
        assert result.failed is False

    def test_satisfied_version_is_ok(self) -> None:
        spec = RequirementSpec(kind=ProbeKind.VERSION, name="blender", expect=">=4.0")
        result = evaluate_probe(spec, Observation(found=True, version="4.2.1"))
        assert result.outcome == PROBE_OK
        assert result.observed == "4.2.1"

    def test_violated_version_is_mismatch(self) -> None:
        spec = RequirementSpec(kind=ProbeKind.VERSION, name="blender", expect=">=4.0")
        result = evaluate_probe(spec, Observation(found=True, version="3.6.0"))
        assert result.outcome == PROBE_MISMATCH
        assert result.failed is True
        assert "3.6.0" in result.detail

    def test_no_expectation_accepts_any_version(self) -> None:
        result = evaluate_probe(RequirementSpec(kind=ProbeKind.VERSION, name="node"), Observation(found=True, version="20.11.0"))
        assert result.outcome == PROBE_OK

    def test_unparsable_constraint_is_unknown(self) -> None:
        spec = RequirementSpec(kind=ProbeKind.VERSION, name="node", expect=">=v")
        result = evaluate_probe(spec, Observation(found=True, version="20.11.0"))
        assert result.outcome == PROBE_UNKNOWN

    def test_probe_error_detail_is_preserved(self) -> None:
        spec = RequirementSpec(kind=ProbeKind.VERSION, name="node")
        result = evaluate_probe(spec, Observation(found=None, detail="timeout after 5s"))
        assert result.outcome == PROBE_UNKNOWN
        assert result.detail == "timeout after 5s"


class TestSummarize:
    @staticmethod
    def _report(name: str, outcome: str, *, optional: bool = False, source: str = "app:x") -> RequirementReport:
        return RequirementReport(
            source=source,
            label=name,
            results=(ProbeResult(spec=RequirementSpec(kind=ProbeKind.EXECUTABLE, name=name, optional=optional), outcome=outcome),),
        )

    def test_empty_is_ok(self) -> None:
        assert summarize([]) == OVERALL_OK

    def test_all_satisfied_is_ok(self) -> None:
        assert summarize([self._report("a", PROBE_OK), self._report("b", PROBE_OK)]) == OVERALL_OK

    def test_required_failure_dominates(self) -> None:
        reports = [self._report("a", PROBE_OK), self._report("b", PROBE_MISSING)]
        assert summarize(reports) == OVERALL_MISSING

    def test_optional_failure_is_degraded(self) -> None:
        assert summarize([self._report("a", PROBE_OK), self._report("b", PROBE_MISMATCH, optional=True)]) == OVERALL_DEGRADED

    def test_unknown_is_degraded(self) -> None:
        assert summarize([self._report("a", PROBE_UNKNOWN)]) == OVERALL_DEGRADED

    def test_unknown_does_not_become_missing(self) -> None:
        assert summarize([self._report("a", PROBE_OK), self._report("b", PROBE_UNKNOWN)]) == OVERALL_DEGRADED

    def test_required_failures_skips_unknown_and_optional(self) -> None:
        reports = [
            self._report("a", PROBE_MISSING),
            self._report("b", PROBE_UNKNOWN),
            self._report("c", PROBE_MISMATCH, optional=True),
            self._report("d", PROBE_OK),
        ]
        failures = required_failures(reports)
        assert [result.spec.name for result in failures] == ["a"]
