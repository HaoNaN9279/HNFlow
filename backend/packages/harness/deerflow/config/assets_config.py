"""``assets`` configuration section (N9, dev plan §20).

Declares the operator-owned side of the asset layer:

- ``roots`` — the host directories the workflow is allowed to move assets
  in and out of.  **Empty (the default) disables host ↔ sandbox transfer
  entirely**, so an untouched deployment behaves exactly as it did before N9
  and enabling the capability is an explicit operator decision.
- ``max_bytes`` — a single-file ceiling for both directions.
- ``contracts`` — named cross-software data contracts (extensions / media type
  / unit / axis conventions) that ``data:asset`` can validate against.
- ``converters`` — named format conversions; the command runs **in the
  sandbox** (see ``workflow/executors/asset.py``).

Like the ``apps`` and ``scheduler`` sections this is startup-only
(``reload_boundary.STARTUP_ONLY_FIELDS``).
"""

from __future__ import annotations

import logging
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from deerflow.assets.contracts import AssetContract, AssetConverter
from deerflow.assets.ref import normalize_host_path

logger = logging.getLogger(__name__)

#: Asset entry-name grammar (shared shape with app names / lock names).
ASSET_NAME_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"
_ASSET_NAME_RE = re.compile(ASSET_NAME_PATTERN)

#: Default single-file transfer ceiling (512 MiB).
DEFAULT_MAX_ASSET_BYTES = 512 * 1024 * 1024


class AssetsConfig(BaseModel):
    """Asset transfer + contract configuration (``config.yaml -> assets``)."""

    model_config = ConfigDict(extra="forbid")

    roots: list[str] = Field(
        default_factory=list,
        description="Host directories allowed to exchange assets with the sandbox. Empty = host transfer disabled.",
    )
    max_bytes: int = Field(default=DEFAULT_MAX_ASSET_BYTES, ge=1, description="Maximum size of one transferred asset in bytes.")
    contracts: dict[str, AssetContract] = Field(default_factory=dict, description="Named cross-software data contracts.")
    converters: dict[str, AssetConverter] = Field(default_factory=dict, description="Named format converters (commands run in the sandbox).")

    @field_validator("roots")
    @classmethod
    def _normalize_roots(cls, value: list[str]) -> list[str]:
        normalized: list[str] = []
        for item in value:
            text = str(item).strip()
            if not text:
                raise ValueError("assets.roots entries must not be empty")
            path = normalize_host_path(text)
            if path not in normalized:
                normalized.append(path)
        return normalized

    @field_validator("contracts", "converters")
    @classmethod
    def _validate_names(cls, value: dict[str, Any]) -> dict[str, Any]:
        for name in value:
            if _ASSET_NAME_RE.match(name) is None:
                raise ValueError(f"asset name {name!r} must match {ASSET_NAME_PATTERN}")
        return value

    # ── derived views ────────────────────────────────────────────────────

    @property
    def host_transfer_enabled(self) -> bool:
        """``True`` when at least one host root is configured."""
        return bool(self.roots)

    @property
    def root_paths(self) -> list[Path]:
        """Configured roots as :class:`Path` objects."""
        return [Path(root) for root in self.roots]

    def allows_host_path(self, path: str) -> bool:
        """Return ``True`` when *path* (normalised) sits inside a configured root.

        This is a **lexical** containment check on normalised paths; the caller
        is responsible for resolving symlinks before calling it (see
        ``resolve_asset_path`` in the executor), because only the caller can
        report *why* a path was rejected.
        """
        if not self.roots:
            return False
        target = Path(normalize_host_path(path))
        return any(target == root or root in target.parents for root in self.root_paths)

    def contract_for(self, name: str | None) -> AssetContract | None:
        if not name:
            return None
        return self.contracts.get(name)

    def converter_for(self, name: str | None) -> AssetConverter | None:
        if not name:
            return None
        return self.converters.get(name)


# ── Process-wide singleton (mirrors apps_config / acp_config) ──────────────────

_assets_config: AssetsConfig = AssetsConfig()


def get_assets_config() -> AssetsConfig:
    """Return the currently loaded ``assets`` configuration (default: transfer disabled)."""
    return _assets_config


def load_assets_config_from_dict(config_dict: Mapping[str, Any] | None) -> None:
    """Load the ``assets`` section from a plain dict (typically from config.yaml)."""
    global _assets_config
    if config_dict is None:
        config_dict = {}
    _assets_config = AssetsConfig.model_validate(config_dict)
    if _assets_config.host_transfer_enabled:
        logger.info("Asset layer loaded: %d host root(s), %d contract(s), %d converter(s)", len(_assets_config.roots), len(_assets_config.contracts), len(_assets_config.converters))
    else:
        logger.debug("Asset host transfer disabled (assets.roots is empty)")


def reset_assets_config() -> None:
    """Reset the singleton to the default (tests / hot-reload)."""
    global _assets_config
    _assets_config = AssetsConfig()


__all__ = [
    "ASSET_NAME_PATTERN",
    "DEFAULT_MAX_ASSET_BYTES",
    "AssetsConfig",
    "get_assets_config",
    "load_assets_config_from_dict",
    "reset_assets_config",
]
