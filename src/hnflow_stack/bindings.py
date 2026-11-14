"""Model-layer bindings from project defaults and the global config.

The platform catalog owns layer ids and labels. This module maps a layer id to
a concrete host route (provider/model/reasoningEffort) for one agent adapter.
Project defaults live in ``.hnflow/models.json``; the machine-local
``models.bindings.<agent>`` entries in the global config override them one
layer at a time so different hosts can use different model namespaces.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

from hnflow_stack.errors import HNFlowError
from hnflow_stack.model_layers import (
    DEFAULT_MODEL_LAYER,
    MODEL_LAYER_IDS,
    is_model_layer,
    model_layer_catalog,
)
from hnflow_stack.repo import read_global_config, write_global_config

#: Adapter used when the caller does not name one.
DEFAULT_AGENT = "dsh"

_MAX_ID = 32

#: Project-level defaults, relative to a project root.
PROJECT_MODELS_RELATIVE = Path(".hnflow") / "models.json"


@dataclass
class LayerBinding:
    """One host route bound to a platform layer."""

    provider: str
    model: str
    reasoning_effort: str | None = None

    def to_dict(self) -> dict[str, object]:
        data: dict[str, object] = {
            "provider": self.provider,
            "model": self.model,
        }
        if self.reasoning_effort:
            data["reasoningEffort"] = self.reasoning_effort
        return data


@dataclass
class ModelsState:
    """Normalized ``models`` section for one agent."""

    default: str | None
    bindings: dict[str, LayerBinding]
    warnings: list[str]

    def layers(self) -> list[dict[str, object]]:
        """Return the catalog annotated with this agent's bindings."""
        result: list[dict[str, object]] = []
        for layer in model_layer_catalog():
            binding = self.bindings.get(str(layer["id"]))
            result.append(
                {
                    **layer,
                    "binding": binding.to_dict() if binding is not None else None,
                    "bound": binding is not None,
                }
            )
        return result


def _models_section(data: dict[str, object]) -> dict[str, object]:
    models = data.get("models")
    return models if isinstance(models, dict) else {}


def project_models_path(project: Path | None = None) -> Path | None:
    """Locate the project-level ``.hnflow/models.json``.

    An explicit project only checks that root. Without one,
    ``HNFLOW_MODELS_FILE`` wins, then the current directory and its parents
    are searched, then ``HNFLOW_HOME`` / ``HNFLOW_REPO`` and the global
    ``repository``.
    """
    if project is not None:
        candidate = Path(project) / PROJECT_MODELS_RELATIVE
        return candidate if candidate.is_file() else None

    override = os.environ.get("HNFLOW_MODELS_FILE", "").strip()
    if override:
        candidate = Path(override).expanduser()
        return candidate if candidate.is_file() else None

    start = Path.cwd().resolve()
    for root in (start, *start.parents):
        candidate = root / PROJECT_MODELS_RELATIVE
        if candidate.is_file():
            return candidate

    for env_name in ("HNFLOW_HOME", "HNFLOW_REPO"):
        value = os.environ.get(env_name, "").strip()
        if value:
            candidate = Path(value).expanduser() / PROJECT_MODELS_RELATIVE
            if candidate.is_file():
                return candidate

    configured = read_global_config().get("repository")
    if isinstance(configured, str) and configured.strip():
        candidate = Path(configured).expanduser() / PROJECT_MODELS_RELATIVE
        if candidate.is_file():
            return candidate
    return None


def _valid_layer_id(value: str) -> bool:
    return bool(value) and len(value) <= _MAX_ID and is_model_layer(value)


def _normalize_binding(
    raw: object, layer_id: str, warnings: list[str]
) -> LayerBinding | None:
    if not isinstance(raw, dict):
        warnings.append(f"binding {layer_id} is not an object")
        return None
    provider = frontmatter_text(raw.get("provider"))
    model = frontmatter_text(raw.get("model"))
    if not provider or not model:
        warnings.append(f"binding {layer_id} needs provider and model")
        return None
    effort = frontmatter_text(raw.get("reasoningEffort"))
    return LayerBinding(provider=provider, model=model, reasoning_effort=effort or None)


def frontmatter_text(value: object) -> str:
    """Return a trimmed string, accepting only scalar values."""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return ""


def _read_raw_bindings(
    models: dict[str, object], agent: str, warnings: list[str]
) -> tuple[dict[str, object], bool]:
    """Return raw binding entries and whether the legacy list was used."""
    bindings = models.get("bindings")
    if isinstance(bindings, dict):
        raw = bindings.get(agent)
        if raw is not None:
            if isinstance(raw, dict):
                return raw, False
            warnings.append(f"models.bindings.{agent} must be an object")
            return {}, False
        legacy = models.get("layers")
        if isinstance(legacy, list):
            warnings.append(
                "models.layers is a legacy DSH format; run `hnflow-stack models migrate`"
            )
            return {"__legacy__": legacy}, True
        return {}, False
    legacy = models.get("layers")
    if isinstance(legacy, list):
        warnings.append(
            "models.layers is a legacy DSH format; run `hnflow-stack models migrate`"
        )
        return {"__legacy__": legacy}, True
    if bindings is not None:
        warnings.append("models.bindings must be an object")
    return {}, False


def _normalize_entries(
    raw: object, warnings: list[str], *, legacy: bool = False
) -> dict[str, LayerBinding]:
    result: dict[str, LayerBinding] = {}
    entries: list[tuple[str, object]]
    if legacy and isinstance(raw, dict):
        entries = []
        for item in raw.get("__legacy__", []):
            if not isinstance(item, dict):
                warnings.append("legacy model layer entry is not an object")
                continue
            layer_id = frontmatter_text(item.get("id"))
            if layer_id == "flash":
                layer_id = "fast"
            entries.append((layer_id, item))
    elif isinstance(raw, dict):
        entries = [(str(key), value) for key, value in raw.items()]
    elif isinstance(raw, list):
        entries = []
        for item in raw:
            if not isinstance(item, dict):
                warnings.append("model binding entry is not an object")
                continue
            entries.append((frontmatter_text(item.get("id")), item))
    else:
        return result

    for layer_id, item in entries:
        if not _valid_layer_id(layer_id):
            warnings.append(f"unknown model layer binding: {layer_id or '(empty)'}")
            continue
        binding = _normalize_binding(item, layer_id, warnings)
        if binding is None:
            continue
        if layer_id in result:
            warnings.append(f"duplicate model layer binding: {layer_id}")
        result[layer_id] = binding
    return result


def _normalize_default(value: object, warnings: list[str]) -> str | None:
    default = frontmatter_text(value) or None
    if default == "flash":
        default = "fast"
    if default is not None and not _valid_layer_id(default):
        warnings.append(f"unknown default model layer: {default}")
        return None
    return default


def _read_global_state(document: dict[str, object], agent: str) -> ModelsState:
    models = _models_section(document)
    warnings: list[str] = []
    raw, legacy = _read_raw_bindings(models, agent, warnings)
    bindings = _normalize_entries(raw, warnings, legacy=legacy)
    default = _normalize_default(models.get("default"), warnings)
    return ModelsState(default=default, bindings=bindings, warnings=warnings)


def _read_project_state(
    agent: str, project: Path | None = None
) -> tuple[ModelsState, Path | None]:
    path = project_models_path(project)
    if path is None:
        return ModelsState(default=None, bindings={}, warnings=[]), None
    warnings: list[str] = []
    try:
        document = json.loads(path.read_text(encoding="utf-8-sig"))
    except UnicodeDecodeError as exc:
        warnings.append(f"invalid UTF-8 in project model defaults {path}: {exc}")
        return ModelsState(default=None, bindings={}, warnings=warnings), path
    except json.JSONDecodeError as exc:
        warnings.append(f"invalid JSON in project model defaults {path}: {exc}")
        return ModelsState(default=None, bindings={}, warnings=warnings), path
    except OSError as exc:
        warnings.append(f"cannot read project model defaults {path}: {exc}")
        return ModelsState(default=None, bindings={}, warnings=warnings), path
    if not isinstance(document, dict):
        warnings.append(f"project model defaults {path} must be a JSON object")
        return ModelsState(default=None, bindings={}, warnings=warnings), path

    version = document.get("schema_version")
    if version is not None and version != 1:
        warnings.append(f"unsupported project model schema_version: {version}")

    raw_bindings = document.get("bindings")
    if raw_bindings is None:
        raw_bindings = {}
    if not isinstance(raw_bindings, dict):
        warnings.append("project model defaults bindings must be an object")
        raw_bindings = {}
    raw = raw_bindings.get(agent)
    if raw is None:
        raw = {}
    elif not isinstance(raw, (dict, list)):
        warnings.append(f"project model defaults bindings.{agent} must be an object")
        raw = {}

    bindings = _normalize_entries(raw, warnings)
    default = _normalize_default(document.get("default"), warnings)
    return ModelsState(default=default, bindings=bindings, warnings=warnings), path


def read_models_state(
    agent: str = DEFAULT_AGENT,
    data: dict[str, object] | None = None,
    *,
    include_project: bool = True,
    project: Path | None = None,
) -> ModelsState:
    """Read project defaults, then overlay the machine-local bindings.

    Project values are defaults; explicit ``models.bindings.<agent>`` entries
    in the global config win one layer at a time. Mutating commands pass
    ``include_project=False`` so they never copy project defaults into the
    user's home config.
    """
    document = read_global_config() if data is None else data
    global_state = _read_global_state(document, agent)
    if not include_project:
        return global_state

    project_state, _ = _read_project_state(agent, project)
    bindings = dict(project_state.bindings)
    bindings.update(global_state.bindings)
    return ModelsState(
        default=global_state.default or project_state.default,
        bindings=bindings,
        warnings=[*project_state.warnings, *global_state.warnings],
    )


def _write_state(
    agent: str,
    bindings: dict[str, LayerBinding],
    default: str | None,
    *,
    keep_default: bool = True,
) -> ModelsState:
    document = read_global_config()
    models = _models_section(document)
    bindings_all = models.get("bindings")
    if not isinstance(bindings_all, dict):
        bindings_all = {}
    bindings_all[agent] = {
        layer_id: binding.to_dict()
        for layer_id, binding in sorted(bindings.items())
    }
    models["bindings"] = bindings_all
    if keep_default:
        if default is None:
            models.pop("default", None)
        else:
            models["default"] = default
    document["models"] = models
    write_global_config(document)
    return ModelsState(default=default, bindings=dict(bindings), warnings=[])


def bind_layer(
    layer_id: str,
    *,
    agent: str = DEFAULT_AGENT,
    provider: str,
    model: str,
    reasoning_effort: str | None = None,
) -> ModelsState:
    """Bind one platform layer to a host route."""
    if not _valid_layer_id(layer_id):
        raise HNFlowError(f"unknown model layer: {layer_id}")
    if not provider.strip() or not model.strip():
        raise HNFlowError("provider and model must be non-empty")
    state = read_models_state(agent, include_project=False)
    state.bindings[layer_id] = LayerBinding(
        provider=provider.strip(),
        model=model.strip(),
        reasoning_effort=(reasoning_effort or "").strip() or None,
    )
    return _write_state(agent, state.bindings, state.default, keep_default=False)


def unbind_layer(layer_id: str, *, agent: str = DEFAULT_AGENT) -> ModelsState:
    """Remove one layer binding."""
    if not _valid_layer_id(layer_id):
        raise HNFlowError(f"unknown model layer: {layer_id}")
    state = read_models_state(agent, include_project=False)
    state.bindings.pop(layer_id, None)
    return _write_state(agent, state.bindings, state.default, keep_default=False)


def set_default_layer(
    layer_id: str | None, *, agent: str = DEFAULT_AGENT
) -> ModelsState:
    """Set or clear the global default layer."""
    if layer_id is not None and not _valid_layer_id(layer_id):
        raise HNFlowError(f"unknown model layer: {layer_id}")
    state = read_models_state(agent, include_project=False)
    return _write_state(agent, state.bindings, layer_id)


def migrate_legacy(*, agent: str = DEFAULT_AGENT) -> ModelsState:
    """Convert ``models.layers`` into ``models.bindings.<agent>``.

    ``flash`` is mapped to ``fast``; entries whose id is not a platform layer
    are reported and dropped. The legacy key is removed after a successful
    write.
    """
    document = read_global_config()
    models = _models_section(document)
    legacy = models.get("layers")
    warnings: list[str] = []
    if not isinstance(legacy, list):
        return ModelsState(default=None, bindings={}, warnings=["no models.layers to migrate"])
    bindings = _normalize_entries({"__legacy__": legacy}, warnings, legacy=True)
    default = frontmatter_text(models.get("default")) or None
    if default == "flash":
        default = "fast"
    if default is not None and not _valid_layer_id(default):
        warnings.append(f"dropped unknown default model layer: {default}")
        default = None
    models.pop("layers", None)
    models["bindings"] = {
        **(models.get("bindings") if isinstance(models.get("bindings"), dict) else {}),
        agent: {
            layer_id: binding.to_dict()
            for layer_id, binding in sorted(bindings.items())
        },
    }
    if default is None:
        models.pop("default", None)
    else:
        models["default"] = default
    document["models"] = models
    write_global_config(document)
    return ModelsState(default=default, bindings=bindings, warnings=warnings)


def models_summary(agent: str = DEFAULT_AGENT) -> dict[str, object]:
    """Return a JSON-ready catalog plus bindings for one agent."""
    state = read_models_state(agent)
    config = project_models_path()
    document: dict[str, object] = {
        "schema_version": 1,
        "agent": agent,
        "default": state.default or DEFAULT_MODEL_LAYER,
        "layers": state.layers(),
        "warnings": state.warnings,
    }
    if config is not None:
        document["config"] = str(config)
    return document


def catalog_document() -> dict[str, object]:
    """Return the platform catalog only."""
    return {
        "schema_version": 1,
        "default": DEFAULT_MODEL_LAYER,
        "layers": model_layer_catalog(),
    }


__all__ = [
    "DEFAULT_AGENT",
    "DEFAULT_MODEL_LAYER",
    "LayerBinding",
    "MODEL_LAYER_IDS",
    "ModelsState",
    "PROJECT_MODELS_RELATIVE",
    "bind_layer",
    "catalog_document",
    "is_model_layer",
    "migrate_legacy",
    "models_summary",
    "project_models_path",
    "read_models_state",
    "set_default_layer",
    "unbind_layer",
]
