"""Pydantic schemas for file-backed projects and workbenches."""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

PROJECT_SCHEMA_VERSION = 3
WORKBENCH_SCHEMA_VERSION = 1

_PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_WORKBENCH_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_ROOT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

#: Workbench settings are presentation-only.  Project-scoped configuration
#: belongs in ``project.json``; accepting these keys here would create a second
#: source of truth.
_FORBIDDEN_WORKBENCH_SETTINGS = frozenset(
    {
        "capability_groups",
        "default_environment",
        "mcp_allowlist",
        "project_id",
        "roots",
        "secret_refs",
    }
)


class ProjectRoot(BaseModel):
    """A project-relative source root."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(default="main", min_length=1, max_length=64)
    path: str = Field(default=".", min_length=1)
    mode: Literal["rw", "ro"] = "rw"

    @field_validator("id")
    @classmethod
    def _validate_id(cls, value: str) -> str:
        if not _ROOT_ID_RE.fullmatch(value):
            raise ValueError(f"root id must match {_ROOT_ID_RE.pattern}; got {value!r}")
        return value

    @field_validator("path")
    @classmethod
    def _validate_path(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("root path must be non-empty")
        if "\x00" in normalized:
            raise ValueError("root path must not contain NUL")
        return normalized


class ProjectManifest(BaseModel):
    """The contents of ``<project>/.hnflow/project.json``."""

    model_config = ConfigDict(extra="forbid")

    schema_version: int = PROJECT_SCHEMA_VERSION
    project_id: str
    name: str = Field(min_length=1, max_length=255)
    description: str = ""
    default_environment: str | None = Field(default=None, max_length=64)
    roots: list[ProjectRoot] = Field(default_factory=lambda: [ProjectRoot()])
    mcp_allowlist: list[str] = Field(default_factory=list)
    secret_refs: list[str] = Field(default_factory=list)
    settings: dict[str, Any] = Field(default_factory=dict)

    @field_validator("project_id")
    @classmethod
    def _validate_project_id(cls, value: str) -> str:
        if not _PROJECT_ID_RE.fullmatch(value):
            raise ValueError(f"project_id must match {_PROJECT_ID_RE.pattern}; got {value!r}")
        return value

    @field_validator("roots")
    @classmethod
    def _validate_roots(cls, value: list[ProjectRoot]) -> list[ProjectRoot]:
        if not value:
            raise ValueError("at least one project root is required")
        ids = [root.id for root in value]
        if len(ids) != len(set(ids)):
            raise ValueError("project root ids must be unique")
        return value


class WorkbenchMember(BaseModel):
    """A workflow definition shown on a workbench file."""

    model_config = ConfigDict(extra="forbid")

    definition_id: str = Field(min_length=1, max_length=64)
    order_index: int = Field(default=0, ge=0)
    settings: dict[str, Any] = Field(default_factory=dict)


class WorkbenchFile(BaseModel):
    """The contents of ``<project>/.hnflow/workbenches/<id>.workbench.json``."""

    model_config = ConfigDict(extra="forbid")

    schema_version: int = WORKBENCH_SCHEMA_VERSION
    project_id: str
    workbench_id: str
    name: str = Field(min_length=1, max_length=255)
    description: str = ""
    layout: dict[str, Any] = Field(default_factory=lambda: {"version": 1, "cards": []})
    settings: dict[str, Any] = Field(default_factory=dict)
    members: list[WorkbenchMember] = Field(default_factory=list)
    revision: int = Field(default=1, ge=1)
    created_at: str = ""
    updated_at: str = ""

    @field_validator("project_id")
    @classmethod
    def _validate_project_id(cls, value: str) -> str:
        if not _PROJECT_ID_RE.fullmatch(value):
            raise ValueError(f"project_id must match {_PROJECT_ID_RE.pattern}; got {value!r}")
        return value

    @field_validator("workbench_id")
    @classmethod
    def _validate_workbench_id(cls, value: str) -> str:
        if not _WORKBENCH_ID_RE.fullmatch(value):
            raise ValueError(f"workbench_id must match {_WORKBENCH_ID_RE.pattern}; got {value!r}")
        return value

    @field_validator("settings")
    @classmethod
    def _validate_settings(cls, value: dict[str, Any]) -> dict[str, Any]:
        forbidden = sorted(set(value) & _FORBIDDEN_WORKBENCH_SETTINGS)
        if forbidden:
            raise ValueError(f"workbench settings must not contain project-scoped keys: {forbidden}")
        return value

    @model_validator(mode="after")
    def _validate_members(self) -> WorkbenchFile:
        definition_ids = [member.definition_id for member in self.members]
        if len(definition_ids) != len(set(definition_ids)):
            raise ValueError("workbench members must have unique definition ids")
        return self
