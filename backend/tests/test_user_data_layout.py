"""Unified ``hnflow-data`` layout, path precedence, and configuration examples."""

from __future__ import annotations

import json
from pathlib import Path

import yaml

from deerflow.config import paths as paths_module
from deerflow.config.app_config import AppConfig
from deerflow.config.database_config import DatabaseConfig
from deerflow.config.extensions_config import ExtensionsConfig
from deerflow.config.paths import Paths
from deerflow.config.runtime_paths import USER_DATA_DIRNAME, user_data_home
from deerflow.workflow.schema import WorkflowDefinition
from deerflow.workflow.workflow_io import validate_definition

REPO_ROOT = Path(__file__).resolve().parents[2]
EXAMPLES = REPO_ROOT / "config-examples"


def _clear_home_env(monkeypatch) -> None:
    monkeypatch.delenv("HNFLOW_HOME", raising=False)
    monkeypatch.delenv("DEER_FLOW_HOME", raising=False)


def test_hnflow_home_wins_over_legacy_alias(tmp_path: Path, monkeypatch) -> None:
    _clear_home_env(monkeypatch)
    monkeypatch.setenv("HNFLOW_HOME", str(tmp_path / "canonical"))
    monkeypatch.setenv("DEER_FLOW_HOME", str(tmp_path / "legacy"))

    assert user_data_home() == (tmp_path / "canonical").resolve()


def test_legacy_home_alias_remains_supported(tmp_path: Path, monkeypatch) -> None:
    _clear_home_env(monkeypatch)
    monkeypatch.setenv("DEER_FLOW_HOME", str(tmp_path / "legacy"))

    assert user_data_home() == (tmp_path / "legacy").resolve()


def test_paths_expose_the_unified_subdirectories(tmp_path: Path) -> None:
    paths = Paths(base_dir=tmp_path / USER_DATA_DIRNAME)

    assert paths.config_file == paths.base_dir / "config.yaml"
    assert paths.extensions_config_file == paths.base_dir / "extensions_config.json"
    assert paths.env_file == paths.base_dir / ".env"
    assert paths.lead_agent_prompt_file == paths.base_dir / "prompts" / "lead-agent.md"
    assert paths.capability_groups_dir == paths.base_dir / "capability-groups"
    assert paths.tool_packages_dir == paths.base_dir / "tools"
    assert paths.skills_dir == paths.base_dir / "skills"


def test_lead_agent_prompt_example_exists() -> None:
    prompt = EXAMPLES / "prompts" / "lead-agent.md"
    assert prompt.is_file()
    assert "HNFlow Lead Agent" in prompt.read_text(encoding="utf-8")


def test_workflow_examples_are_valid() -> None:
    for path in sorted((EXAMPLES / "workflows").glob("*.json")):
        definition = WorkflowDefinition.model_validate(json.loads(path.read_text(encoding="utf-8")))
        assert validate_definition(definition) == [], path.name


def test_model_profile_example_has_required_fields() -> None:
    payload = yaml.safe_load((EXAMPLES / "model-profiles" / "default.yaml").read_text(encoding="utf-8"))

    assert payload["name"] == "default"
    assert payload["target_model"]
    assert isinstance(payload["enabled"], bool)


def test_runtime_data_is_gitignored() -> None:
    ignored = (REPO_ROOT / ".gitignore").read_text(encoding="utf-8")
    assert "/hnflow-data/" in ignored
    assert "/backend/hnflow-data/" in ignored


def test_config_and_extensions_prefer_unified_root(tmp_path: Path, monkeypatch) -> None:
    _clear_home_env(monkeypatch)
    home = tmp_path / "data"
    home.mkdir()
    (home / "config.yaml").write_text("sandbox:\n  use: deerflow.sandbox.local:LocalSandboxProvider\n", encoding="utf-8")
    (home / "extensions_config.json").write_text('{"mcpServers": {}, "skills": {}}', encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("HNFLOW_HOME", str(home))

    assert AppConfig.resolve_config_path() == home / "config.yaml"
    assert ExtensionsConfig.resolve_config_path() == home / "extensions_config.json"


def test_sqlite_relative_dir_resolves_under_unified_root(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "data"
    monkeypatch.setattr(paths_module, "_paths", Paths(base_dir=home))

    database = DatabaseConfig(backend="sqlite", sqlite_dir="data")

    assert Path(database.sqlite_path) == home / "data" / "deerflow.db"


def test_migration_script_is_copy_only_and_idempotent(tmp_path: Path) -> None:
    from migrate_user_data import Migrator

    project = tmp_path / "project"
    legacy = project / "backend" / ".deer-flow"
    target = project / "hnflow-data"
    legacy.mkdir(parents=True)
    (project / "config.yaml").write_text("config_version: 40\n", encoding="utf-8")
    (legacy / "SOUL.md").write_text("legacy prompt", encoding="utf-8")
    (legacy / ".jwt_secret").write_text("secret", encoding="utf-8")
    (legacy / "users" / "u1" / "skills_view").mkdir(parents=True)
    (legacy / "users" / "u1" / "skills_view" / ".projection-manifest.json").write_text("{}", encoding="utf-8")

    first = Migrator(project_root=project, target=target, dry_run=False, force=False).run()
    second = Migrator(project_root=project, target=target, dry_run=False, force=False).run()

    assert first == 0
    assert second == 0
    assert (target / "config.yaml").read_text(encoding="utf-8") == "config_version: 40\n"
    assert (target / "prompts" / "lead-agent.md").read_text(encoding="utf-8") == "legacy prompt"
    assert (target / ".jwt_secret").read_text(encoding="utf-8") == "secret"
    assert (project / "config.yaml").is_file(), "migration must not delete the legacy source"
    assert not (target / "users" / "u1" / "skills_view" / ".projection-manifest.json").exists()
