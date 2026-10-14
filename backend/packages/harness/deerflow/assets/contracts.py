"""Cross-software data contracts (N9, dev plan §20).

A *contract* is the declared shape of an asset that several local
applications must agree on: which extensions are acceptable, the media type,
and the unit / axis conventions the geometry inside is authored in.  A
*converter* is the declared way to move from one format to another.

Both are pure declarations: this module performs no I/O and runs no command.
Validation of an actual asset against a contract lives in
:mod:`deerflow.assets.ref` (which owns :class:`~deerflow.assets.ref.AssetRef`)
so the dependency direction stays one-way (``ref`` → ``contracts``).

Converters deliberately carry a *command template* rather than a Python
callable: the command is executed through the sandbox by
``workflow/executors/asset.py``, which keeps the "commands must go through the
sandbox" rule intact (the host-side app driver remains the only exception).
"""

from __future__ import annotations

import re

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

_EXTENSION_RE = re.compile(r"^\.[A-Za-z0-9][A-Za-z0-9_.+-]{0,15}$")

#: Placeholders a converter's ``args`` may use.
IN_PLACEHOLDER = "{in}"
OUT_PLACEHOLDER = "{out}"


def normalize_extension(value: str) -> str:
    """Return *value* as a lowercase, dot-prefixed, validated extension.

    Accepts ``fbx`` and ``.FBX`` alike; raises :class:`ValueError` otherwise.
    """
    text = str(value).strip().lower()
    if not text:
        raise ValueError("extension must not be empty")
    if not text.startswith("."):
        text = f".{text}"
    if _EXTENSION_RE.match(text) is None:
        raise ValueError(f"invalid extension {value!r}")
    return text


class AssetContractError(ValueError):
    """Raised when an asset does not satisfy its declared contract.

    Carries the expected/actual values so an executor can name both in the
    workflow error (the N7 retry/DLQ layer and the operator both need to know
    *which* part of the contract was violated).
    """

    def __init__(self, message: str, *, contract: str | None = None, expected: str | None = None, actual: str | None = None) -> None:
        super().__init__(message)
        self.contract = contract
        self.expected = expected
        self.actual = actual


class AssetContract(BaseModel):
    """Declared shape of a cross-software asset.

    An empty ``extensions`` list means "no extension restriction"; ``unit`` /
    ``up_axis`` / ``axes`` are declarative metadata for cross-software
    hand-off (N9 does not convert units or axes).
    """

    model_config = ConfigDict(extra="forbid")

    description: str = Field(default="", description="Human-readable summary of what this contract is for.")
    extensions: list[str] = Field(default_factory=list, description="Accepted file extensions (dot-prefixed, lowercase). Empty = unrestricted.")
    media_type: str | None = Field(default=None, description="Expected media type, e.g. 'application/x-blender'.")
    unit: str | None = Field(default=None, description="Length unit the geometry is authored in (e.g. 'm', 'cm').")
    up_axis: str | None = Field(default=None, description="Declared up axis (e.g. 'Z' for Blender, 'Y' for Unity).")
    axes: str | None = Field(default=None, description="Axis / handedness convention note (e.g. 'right-handed').")
    notes: str | None = Field(default=None, description="Free-form operator note carried on the asset reference.")

    @field_validator("extensions")
    @classmethod
    def _normalize_extensions(cls, value: list[str]) -> list[str]:
        normalized: list[str] = []
        for item in value:
            extension = normalize_extension(item)
            if extension not in normalized:
                normalized.append(extension)
        return normalized

    @field_validator("media_type")
    @classmethod
    def _normalize_media_type(cls, value: str | None) -> str | None:
        if value is None:
            return None
        text = value.strip().lower()
        return text or None

    def accepts_extension(self, extension: str | None) -> bool:
        """Return ``True`` when *extension* satisfies this contract."""
        if not self.extensions:
            return True
        if extension is None:
            return False
        return extension.lower() in self.extensions

    def describe(self) -> str:
        """Render the contract's expectations for an error message."""
        parts: list[str] = []
        if self.extensions:
            parts.append("extensions " + "/".join(self.extensions))
        if self.media_type:
            parts.append(f"media_type {self.media_type}")
        if self.unit:
            parts.append(f"unit {self.unit}")
        if self.up_axis:
            parts.append(f"up_axis {self.up_axis}")
        return ", ".join(parts) or "no restriction"


class AssetConverter(BaseModel):
    """Declared format conversion between two extensions.

    ``args`` is a command template: every occurrence of ``{in}`` is replaced
    with the source path and ``{out}`` with the target path (both sandbox
    virtual paths) before the command runs in the sandbox.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    from_extension: str = Field(alias="from", description="Source extension this converter accepts.")
    to_extension: str = Field(alias="to", description="Target extension this converter produces.")
    command: str = Field(default="", description="Executable run inside the sandbox.")
    args: list[str] = Field(default_factory=list, description="Argument template; must contain {in} and {out}.")
    timeout_seconds: int = Field(default=600, ge=1, description="Wall-clock cap for the conversion command.")
    description: str = Field(default="", description="Human-readable summary shown in tool/palette help.")

    @field_validator("from_extension", "to_extension", mode="before")
    @classmethod
    def _normalize_extension_fields(cls, value: str) -> str:
        return normalize_extension(value)

    @model_validator(mode="after")
    def _require_template(self) -> AssetConverter:
        if not self.command.strip():
            raise ValueError("converter requires a 'command'")
        rendered = " ".join([self.command, *self.args])
        if IN_PLACEHOLDER not in rendered:
            raise ValueError(f"converter args must reference the source path with {IN_PLACEHOLDER}")
        if OUT_PLACEHOLDER not in rendered:
            raise ValueError(f"converter args must reference the target path with {OUT_PLACEHOLDER}")
        return self

    def build_command(self, *, source: str, target: str) -> list[str]:
        """Render the argv for one conversion (``{in}`` / ``{out}`` replaced)."""
        return [self.command, *(arg.replace(IN_PLACEHOLDER, source).replace(OUT_PLACEHOLDER, target) for arg in self.args)]


__all__ = [
    "AssetContract",
    "AssetContractError",
    "AssetConverter",
    "IN_PLACEHOLDER",
    "OUT_PLACEHOLDER",
    "normalize_extension",
]
