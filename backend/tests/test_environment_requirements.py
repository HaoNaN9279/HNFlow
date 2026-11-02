"""N11 S4 — collecting and validating requirements from apps and capability groups.

Probe targets are built from ``sys.executable`` so nothing here needs real
professional software installed.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from deerflow.config.apps_config import AppDefinition, AppsConfig
from deerflow.environment.probe import clear_probe_cache
from deerflow.environment.requirements import (
    app_requirement_specs,
    app_version_spec,
    collect_sources,
    detect_app_version,
    skill_requirement_specs,
    validate_environment,
)
from deerflow.environment.spec import OVERALL_DEGRADED, OVERALL_MISSING, OVERALL_OK, PROBE_OK, ProbeKind, RequirementSpec
from deerflow.skills.types import Skill, SkillCategory

MISSING = "definitely-not-installed-xyz-12345"


@pytest.fixture(autouse=True)
def _clear_cache() -> None:
    clear_probe_cache()


def _registry(**definitions: AppDefinition):
    from deerflow.apps.registry import AppRegistry

    return AppRegistry.from_config(AppsConfig(enabled=True, definitions=definitions))


def _skill(name: str, requirements: tuple[RequirementSpec, ...], *, enabled: bool = True, tmp_path: Path | None = None) -> Skill:
    directory = (tmp_path or Path(".")) / name
    return Skill(
        name=name,
        description=f"{name} skill",
        license=None,
        skill_dir=directory,
        skill_file=directory / "SKILL.md",
        relative_path=Path(name),
        category=SkillCategory.CUSTOM,
        enabled=enabled,
        requirements=requirements,
    )


def _spec_present() -> RequirementSpec:
    return RequirementSpec(kind=ProbeKind.EXECUTABLE, name=sys.executable)


def _spec_missing(name: str = MISSING) -> RequirementSpec:
    return RequirementSpec(kind=ProbeKind.EXECUTABLE, name=name)


# ── collecting ────────────────────────────────────────────────────────────────


class TestCollectSources:
    def test_apps_and_skills_are_grouped_by_source(self, tmp_path: Path) -> None:
        registry = _registry(blender=AppDefinition(driver="mock", requires=[_spec_present()]))
        skills = [_skill("cad-export", (_spec_present(),), tmp_path=tmp_path)]
        sources = collect_sources(registry=registry, skills=skills)
        assert [source.source for source in sources] == ["app:blender", "skill:cad-export"]
        assert sources[0].label == "blender"  # falls back to the name when there is no description

    def test_sources_without_requirements_are_skipped(self, tmp_path: Path) -> None:
        registry = _registry(noisy=AppDefinition(driver="mock"))
        skills = [_skill("plain", (), tmp_path=tmp_path)]
        assert collect_sources(registry=registry, skills=skills) == []

    def test_disabled_skill_is_not_a_requirement_on_this_machine(self, tmp_path: Path) -> None:
        skills = [
            _skill("off", (_spec_missing(),), enabled=False, tmp_path=tmp_path),
            _skill("on", (_spec_missing(),), enabled=True, tmp_path=tmp_path),
        ]
        assert [source.source for source in collect_sources(skills=skills)] == ["skill:on"]

    def test_app_working_dir_is_carried_as_the_probe_cwd(self) -> None:
        registry = _registry(app=AppDefinition(driver="cli", command="x", working_dir="~/somewhere", requires=[_spec_present()]))
        source = collect_sources(registry=registry)[0]
        assert source.working_dir is not None
        assert "somewhere" in source.working_dir


class TestAppVersionSpec:
    def test_absent_version_command_yields_no_spec(self) -> None:
        assert app_version_spec(AppDefinition(driver="cli", command="blender")) is None

    def test_version_command_becomes_an_optional_spec_in_script_position(self) -> None:
        definition = AppDefinition(driver="cli", command="blender", args=["--background"], script_args=["-E"], version_command="-v")
        spec = app_version_spec(definition)
        assert spec is not None
        assert spec.optional is True
        assert spec.resolved_command() == ["blender", "--background", "-E", "-v"]

    def test_declared_requirements_precede_the_implicit_version_spec(self) -> None:
        definition = AppDefinition(driver="cli", command="blender", version_command="-v", requires=[_spec_present()])
        specs = app_requirement_specs("blender", definition)
        assert specs[0].kind is ProbeKind.EXECUTABLE
        assert specs[1].kind is ProbeKind.VERSION

    def test_skill_requirement_specs_defaults_to_empty(self, tmp_path: Path) -> None:
        assert skill_requirement_specs(_skill("plain", (), tmp_path=tmp_path)) == ()

    def test_detect_app_version_reads_the_application_answer(self) -> None:
        definition = AppDefinition.model_validate(
            {
                "driver": "cli",
                "command": sys.executable,
                "script_args": ["-c", "print('Blender 4.2.1')"],
                "version_command": "--ignored",
            }
        )
        assert detect_app_version(definition) == "4.2.1"

    def test_detect_app_version_is_none_without_a_version_command(self) -> None:
        assert detect_app_version(AppDefinition(driver="cli", command=sys.executable)) is None


# ── validating ────────────────────────────────────────────────────────────────


class TestValidateEnvironment:
    def test_untouched_configuration_reports_nothing_and_is_ok(self) -> None:
        status = validate_environment(registry=_registry(), skills=[])
        assert status.overall == OVERALL_OK
        assert status.reports == ()
        assert status.failures == ()

    def test_disabled_returns_an_empty_disabled_status(self) -> None:
        status = validate_environment(registry=_registry(blender=AppDefinition(driver="mock", requires=[_spec_missing()])), enabled=False)
        assert status.enabled is False
        assert status.reports == ()

    def test_missing_required_spec_makes_the_environment_missing(self) -> None:
        registry = _registry(blender=AppDefinition(driver="mock", requires=[_spec_missing()]))
        status = validate_environment(registry=registry)
        assert status.overall == OVERALL_MISSING
        assert [result.spec.name for result in status.failures] == [MISSING]

    def test_optional_missing_spec_only_degrades(self) -> None:
        registry = _registry(blender=AppDefinition(driver="mock", requires=[RequirementSpec(kind=ProbeKind.EXECUTABLE, name=MISSING, optional=True)]))
        status = validate_environment(registry=registry)
        assert status.overall == OVERALL_DEGRADED
        assert status.failures == ()

    def test_app_version_probe_shows_up_in_the_report(self, tmp_path: Path) -> None:
        registry = _registry(
            blender=AppDefinition.model_validate(
                {
                    "driver": "cli",
                    "command": sys.executable,
                    "script_args": ["-c", "print('4.2.1')"],
                    "version_command": "--ignored",
                }
            )
        )
        status = validate_environment(registry=registry)
        report = status.reports[0]
        assert report.source == "app:blender"
        assert report.overall == OVERALL_OK
        version_results = [result for result in report.results if result.spec.kind is ProbeKind.VERSION]
        assert version_results[0].observed == "4.2.1"

    def test_skill_and_app_results_stay_in_separate_reports(self, tmp_path: Path) -> None:
        registry = _registry(app=AppDefinition(driver="mock", requires=[_spec_present()]))
        skills = [_skill("cad-export", (_spec_missing(),), tmp_path=tmp_path)]
        status = validate_environment(registry=registry, skills=skills)
        assert [report.source for report in status.reports] == ["app:app", "skill:cad-export"]
        assert status.overall == OVERALL_MISSING
        assert [result.spec.name for result in status.failures] == [MISSING]

    def test_require_on_load_flag_is_carried_on_the_status(self) -> None:
        status = validate_environment(registry=_registry(), require_on_load=True)
        assert status.require_on_load is True

    def test_status_dict_shape(self) -> None:
        registry = _registry(blender=AppDefinition(driver="mock", requires=[_spec_present()]))
        payload = validate_environment(registry=registry).to_dict()
        assert payload["enabled"] is True
        assert payload["overall"] == OVERALL_OK
        assert payload["require_on_load"] is False
        sources = payload["sources"]
        assert isinstance(sources, list) and sources[0]["source"] == "app:blender"  # type: ignore[index]
        assert sources[0]["results"][0]["outcome"] == PROBE_OK  # type: ignore[index]

    def test_force_reprobes_instead_of_reusing_the_cache(self) -> None:
        registry = _registry(blender=AppDefinition(driver="mock", requires=[_spec_present()]))
        validate_environment(registry=registry)
        forced = validate_environment(registry=registry, force=True)
        assert forced.reports[0].results[0].source == "live"
