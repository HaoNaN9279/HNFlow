"""VibeStack repository configuration."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, field_validator


class VibeStackConfig(BaseModel):
    """Where the external VibeStack repository lives.

    ``repository`` is deliberately optional: HNFlow can start without a
    VibeStack checkout, in which case capability-group operations report an
    explicit "not configured" state instead of inventing a fallback directory.
    """

    model_config = ConfigDict(extra="forbid")

    repository: str | None = Field(default=None, description="Absolute path or environment-variable reference for the VibeStack checkout.")
    core: str | None = Field(default=None, description="Optional fixed Core group reference, e.g. core@0.1.0.")

    @field_validator("repository")
    @classmethod
    def _validate_repository(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None

    @field_validator("core")
    @classmethod
    def _validate_core(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None


__all__ = ["VibeStackConfig"]
