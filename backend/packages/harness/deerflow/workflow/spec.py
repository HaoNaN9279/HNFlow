"""Formal specification values shared by workflow nodes and persistence.

A specification is an immutable, versioned document.  Nodes never carry the
full document on a port: a ``spec`` port carries a :class:`SpecRef` and the
run resolves the exact revision through the spec repository.  Keeping the
reference small prevents large proof scripts from being copied into every
checkpoint while still pinning execution to ``(spec_id, revision)``.
"""

from __future__ import annotations

import hashlib
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from deerflow.workflow.schema import NodeType, WorkflowDefinition

SPEC_PORT_TYPE = "spec"


class SpecLanguage(StrEnum):
    DAFNY = "dafny"
    LEAN = "lean"
    TLA = "tla"
    CEL = "cel"


class SpecStatus(StrEnum):
    DRAFT = "draft"
    FROZEN = "frozen"
    SUPERSEDED = "superseded"


def content_hash(content: str) -> str:
    """Stable SHA-256 of the exact specification text."""
    return "sha256:" + hashlib.sha256(content.encode("utf-8")).hexdigest()


class SpecRef(BaseModel):
    """A pinned reference to one immutable specification revision."""

    model_config = ConfigDict(extra="forbid")

    spec_id: str = Field(min_length=1)
    revision: int = Field(ge=1)
    content_hash: str = Field(min_length=1)
    language: SpecLanguage
    title: str | None = None

    @field_validator("spec_id", "content_hash")
    @classmethod
    def _non_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value

    def key(self) -> str:
        return f"{self.spec_id}@{self.revision}"

    def to_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json")


class SpecificationRevision(BaseModel):
    """One immutable stored specification revision."""

    model_config = ConfigDict(extra="forbid")

    spec_id: str
    revision: int = Field(ge=1)
    user_id: str
    language: SpecLanguage
    content: str
    content_hash: str
    status: SpecStatus = SpecStatus.DRAFT
    title: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    approved_by: str | None = None
    approval_task_id: str | None = None
    approved_at: str | None = None

    def ref(self) -> SpecRef:
        return SpecRef(
            spec_id=self.spec_id,
            revision=self.revision,
            content_hash=self.content_hash,
            language=self.language,
            title=self.title,
        )


def parse_spec_ref(value: Any) -> SpecRef:
    """Parse a ``spec`` port value / ``params.spec_ref`` mapping."""
    if isinstance(value, SpecRef):
        return value
    if not isinstance(value, dict):
        raise ValueError("spec reference must be an object {spec_id, revision, content_hash, language}")
    try:
        return SpecRef.model_validate(value)
    except Exception as exc:  # pydantic error is re-raised with a node-friendly message
        raise ValueError(f"invalid spec reference: {exc}") from exc


def collect_spec_refs(definition: WorkflowDefinition) -> list[SpecRef]:
    """Collect every statically declared spec reference in a definition.

    The reference is authoritative on ``verify:gate`` and ``data:spec`` nodes.
    AI nodes may also declare ``params.spec_ref``.  Inline subworkflow bodies are
    walked recursively; template references are resolved by the compiler and
    therefore cannot be collected here.
    """
    refs: list[SpecRef] = []
    seen: set[str] = set()

    def _visit(def_: WorkflowDefinition) -> None:
        for node in def_.nodes:
            raw = node.params.get("spec_ref")
            if raw is not None:
                ref = parse_spec_ref(raw)
                if ref.key() not in seen:
                    seen.add(ref.key())
                    refs.append(ref)
            if node.type in (NodeType.DATA_SPEC, NodeType.VERIFY_GATE):
                # data:spec may resolve a ref from ``params.spec`` as well.
                alt = node.params.get("spec")
                if alt is not None:
                    ref = parse_spec_ref(alt)
                    if ref.key() not in seen:
                        seen.add(ref.key())
                        refs.append(ref)
            body = node.params.get("subworkflow")
            if isinstance(body, dict):
                inline = body.get("definition")
                if isinstance(inline, dict):
                    try:
                        _visit(WorkflowDefinition.model_validate(inline))
                    except Exception:
                        # Shape errors are reported by the compiler with a
                        # precise node id; admission only gathers references.
                        continue

    _visit(definition)
    return refs


__all__ = [
    "SPEC_PORT_TYPE",
    "SpecLanguage",
    "SpecRef",
    "SpecStatus",
    "SpecificationRevision",
    "collect_spec_refs",
    "content_hash",
    "parse_spec_ref",
]
