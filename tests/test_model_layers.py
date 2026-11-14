"""Platform model-layer catalog, resolver output, and models CLI tests."""

from __future__ import annotations

import json
from pathlib import Path

from hnflow_stack.cli import main
from hnflow_stack.model import GroupRef
from hnflow_stack.project import init_stack
from hnflow_stack.repo import global_config_path, read_global_config, write_global_config
from hnflow_stack.resolve import resolve_project


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_catalog_has_four_unique_layers_and_a_default() -> None:
    from hnflow_stack.model_layers import (
        DEFAULT_MODEL_LAYER,
        MODEL_LAYERS,
        is_model_layer,
        model_layer_catalog,
    )

    layers = model_layer_catalog()
    assert [layer["id"] for layer in layers] == ["fast", "standard", "strong", "vision"]
    assert len({layer["id"] for layer in layers}) == 4
    assert DEFAULT_MODEL_LAYER == "standard"
    assert is_model_layer("strong") is True
    assert is_model_layer("turbo") is False
    assert all(layer.label and layer.description for layer in MODEL_LAYERS)


def test_resolve_emits_catalog_and_validates_model_layers(
    repo: Path, project: Path
) -> None:
    core = repo / "capability-groups/core/0.1.0"
    _write(
        core / "agents/model-agent.md",
        "---\nname: ModelAgent\ndescription: model\nmode: all\n"
        "model: strong\n---\nbody\n",
    )
    _write(
        core / "agents/unknown-model.md",
        "---\nname: UnknownModel\ndescription: bad\nmode: all\n"
        "model: turbo\n---\nbody\n",
    )
    _write(
        core / "agents/host-fields.md",
        "---\nname: HostFields\ndescription: bad\nmode: all\n"
        "model: fast\ntemperature: 0.2\nprovider: p\n---\nbody\n",
    )
    init_stack(project, GroupRef("core", "0.1.0"))
    plan = resolve_project(repo, project)
    data = plan.to_dict()
    assert [layer["id"] for layer in data["model_layers"]] == [
        "fast",
        "standard",
        "strong",
        "vision",
    ]
    assert data["model_default"] == "standard"
    assert plan.agents["ModelAgent"].model == "strong"
    assert plan.agents["UnknownModel"].model is None
    assert plan.agents["HostFields"].model == "fast"
    assert any("unknown-model.md" in warning and "invalid model layer" in warning for warning in plan.warnings)
    assert any("host-fields.md" in warning and "temperature" in warning for warning in plan.warnings)
    assert any("host-fields.md" in warning and "provider" in warning for warning in plan.warnings)


def test_inactive_plan_still_carries_the_catalog(repo: Path, project: Path) -> None:
    plan = resolve_project(repo, project)
    assert plan.active is False
    data = plan.to_dict()
    assert [layer["id"] for layer in data["model_layers"]] == [
        "fast",
        "standard",
        "strong",
        "vision",
    ]


def test_checked_in_agents_and_commands_use_only_platform_layers() -> None:
    from hnflow_stack.frontmatter import frontmatter_text, parse_frontmatter
    from hnflow_stack.model_layers import MODEL_LAYER_IDS

    root = Path(__file__).resolve().parents[1] / "capability-groups"
    checked = 0
    for path in [*root.rglob("agents/*.md"), *root.rglob("commands/*.md")]:
        parsed = parse_frontmatter(path.read_text(encoding="utf-8-sig"))
        value = frontmatter_text(parsed.data.get("model"))
        if not value:
            continue
        assert value in MODEL_LAYER_IDS, f"{path}: unknown model layer {value}"
        for forbidden in ("provider", "temperature", "permission", "permissions", "reasoningEffort"):
            assert forbidden not in parsed.data, f"{path}: must not declare {forbidden}"
        checked += 1
    assert checked == 24


def test_checked_in_project_model_defaults_bind_all_four_layers() -> None:
    path = Path(__file__).resolve().parents[1] / ".hnflow/models.json"
    document = json.loads(path.read_text(encoding="utf-8"))
    assert document["schema_version"] == 1
    assert document["default"] == "standard"
    bindings = document["bindings"]["dsh"]
    assert sorted(bindings) == ["fast", "standard", "strong", "vision"]
    for binding in bindings.values():
        assert binding == {"provider": "deepseek-account", "model": "deepseek-flash"}


def test_project_model_defaults_are_shown_and_overridden(
    capsysbinary, monkeypatch
) -> None:
    models_path = Path.cwd() / ".hnflow/models.json"
    monkeypatch.setenv("HNFLOW_MODELS_FILE", str(models_path))
    _write(
        models_path,
        json.dumps(
            {
                "schema_version": 1,
                "default": "standard",
                "bindings": {
                    "dsh": {
                        layer: {
                            "provider": "deepseek-account",
                            "model": "deepseek-flash",
                        }
                        for layer in ("fast", "standard", "strong", "vision")
                    }
                },
            }
        ),
    )
    assert main(["models", "show", "--json"]) == 0
    payload = json.loads(capsysbinary.readouterr().out.decode("utf-8"))
    assert payload["config"] == str(models_path)
    assert payload["default"] == "standard"
    assert all(layer["bound"] for layer in payload["layers"])

    write_global_config(
        {
            "models": {
                "default": "strong",
                "bindings": {
                    "dsh": {
                        "fast": {"provider": "local", "model": "small"},
                    }
                },
            }
        }
    )
    assert main(["models", "show", "--json"]) == 0
    overridden = json.loads(capsysbinary.readouterr().out.decode("utf-8"))
    assert overridden["default"] == "strong"
    assert overridden["layers"][0]["binding"] == {
        "provider": "local",
        "model": "small",
    }
    assert overridden["layers"][1]["binding"]["model"] == "deepseek-flash"

    assert main(["models", "bind", "strong", "--provider", "p", "--model", "m"]) == 0
    capsysbinary.readouterr()
    stored = read_global_config()["models"]["bindings"]["dsh"]
    assert set(stored) == {"fast", "strong"}


def test_invalid_project_model_defaults_warn_without_blocking(
    capsysbinary, monkeypatch
) -> None:
    models_path = Path.cwd() / ".hnflow/models.json"
    monkeypatch.setenv("HNFLOW_MODELS_FILE", str(models_path))
    _write(models_path, "{")
    assert main(["models", "show", "--json"]) == 0
    payload = json.loads(capsysbinary.readouterr().out.decode("utf-8"))
    assert payload["config"] == str(models_path)
    assert any("invalid JSON" in warning for warning in payload["warnings"])
    assert all(layer["bound"] is False for layer in payload["layers"])


def test_cli_models_catalog_does_not_require_a_repository(capsysbinary) -> None:
    assert main(["models", "catalog", "--json"]) == 0
    payload = json.loads(capsysbinary.readouterr().out.decode("utf-8"))
    assert payload["schema_version"] == 1
    assert payload["default"] == "standard"
    assert [layer["id"] for layer in payload["layers"]] == [
        "fast",
        "standard",
        "strong",
        "vision",
    ]


def test_cli_models_bind_show_unbind_and_default(
    isolated_home: Path, capsysbinary
) -> None:
    assert main(["models", "bind", "fast", "--provider", "p", "--model", "m"]) == 0
    capsysbinary.readouterr()
    assert main(["models", "bind", "strong", "--provider", "p", "--model", "m2", "--effort", "high"]) == 0
    capsysbinary.readouterr()
    assert main(["models", "default", "strong"]) == 0
    capsysbinary.readouterr()
    assert main(["models", "show", "--json"]) == 0
    payload = json.loads(capsysbinary.readouterr().out.decode("utf-8"))
    assert payload["default"] == "strong"
    assert payload["layers"][0]["bound"] is True
    assert payload["layers"][0]["binding"]["model"] == "m"
    assert payload["layers"][2]["binding"]["reasoningEffort"] == "high"
    assert main(["models", "unbind", "fast"]) == 0
    capsysbinary.readouterr()
    assert main(["models", "show", "--json"]) == 0
    after = json.loads(capsysbinary.readouterr().out.decode("utf-8"))
    assert after["layers"][0]["bound"] is False
    assert global_config_path().is_relative_to(isolated_home)


def test_cli_models_rejects_unknown_layers(isolated_home: Path, capsys) -> None:
    assert main(["models", "bind", "turbo", "--provider", "p", "--model", "m"]) == 1
    assert "unknown model layer" in capsys.readouterr().err


def test_cli_models_migrates_the_legacy_layers_array(
    isolated_home: Path, capsys
) -> None:
    write_global_config(
        {
            "schema_version": 1,
            "models": {
                "default": "flash",
                "layers": [
                    {"id": "flash", "provider": "p", "model": "m"},
                    {"id": "strong", "provider": "p", "model": "m2"},
                ],
            },
        }
    )
    assert main(["models", "migrate"]) == 0
    capsys.readouterr()
    document = read_global_config()
    models = document["models"]
    assert "layers" not in models
    assert models["default"] == "fast"
    assert models["bindings"]["dsh"]["fast"]["model"] == "m"
    assert models["bindings"]["dsh"]["strong"]["model"] == "m2"
