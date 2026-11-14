"""Agent plugin adapters: discovery and status.

DSH installs adapters itself (``dsh plugin add``), so HNFlow no longer
copies adapter files. This module only discovers manifests and reports what
the adapter declares.
"""

from __future__ import annotations

from pathlib import Path

from hnflow_stack.errors import PluginNotFoundError, HNFlowError
from hnflow_stack.model import read_json


def plugins_dir(repo: Path) -> Path:
    """Return the repository plugins directory."""
    return repo / "plugins"


def discover_plugins(repo: Path) -> list[dict[str, object]]:
    """Discover every ``plugins/<agent>/plugin.json``."""
    base = plugins_dir(repo)
    if not base.is_dir():
        return []
    result: list[dict[str, object]] = []
    for manifest in sorted(base.glob("*/plugin.json")):
        try:
            data = read_json(manifest)
        except HNFlowError:
            continue
        data["root"] = manifest.parent
        result.append(data)
    return result


def load_plugin(repo: Path, agent: str) -> tuple[dict[str, object], Path]:
    """Load one plugin adapter manifest."""
    root = plugins_dir(repo) / agent
    manifest = root / "plugin.json"
    if not manifest.is_file():
        raise PluginNotFoundError(f"plugin adapter '{agent}' not found")
    return read_json(manifest), root


def status(repo: Path, agent: str) -> dict[str, object]:
    """Return the declared status of one plugin adapter.

    DSH owns installation, so ``target``/``installed`` are meaningful only for
    legacy copy-based manifests; for DSH manifests they stay empty/false.
    """
    manifest, root = load_plugin(repo, agent)
    install_data = manifest.get("install")
    target_raw = install_data.get("target") if isinstance(install_data, dict) else None
    target = _expand(str(target_raw)) if isinstance(target_raw, str) else None
    skills_raw = install_data.get("skills_target") if isinstance(install_data, dict) else None
    skills_target = _expand(str(skills_raw)) if isinstance(skills_raw, str) else None
    return {
        "agent": agent,
        "version": manifest.get("version", ""),
        "source": str(root),
        "target": str(target) if target else "",
        "installed": bool(target and target.is_file()),
        "skills_target": str(skills_target) if skills_target else "",
        "skills_installed": bool(skills_target and skills_target.is_dir()),
    }


def _expand(value: str) -> Path:
    if value.startswith("~"):
        return Path.home() / value[1:].lstrip("/\\")
    return Path(value)
