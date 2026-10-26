"""Three-valued verification results and deterministic normalization.

The verifier tool boundary is intentionally narrow: a verifier returns one
JSON document with a ``status`` and structured errors.  Everything a workflow
node consumes is derived here, so a raw TLC/Dafny log never reaches control
flow or a model prompt unnormalized.

The three outcomes are not interchangeable:

``verified``
    The verifier produced evidence that the implementation satisfies the spec.
``failed``
    The verifier produced evidence that it does not.
``inconclusive``
    The verifier could not answer (timeout, abstention, crash, malformed
    output).  This must never be collapsed to ``failed`` or ``verified``.
"""

from __future__ import annotations

import hashlib
import json
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from deerflow.workflow.spec import SpecLanguage, SpecRef

PROTOCOL = "hnflow.verification.v1"

MAX_RAW_OUTPUT_CHARS = 20_000

VERIFY_STATUS_PORT = "status"
VERIFY_VERIFIED_PORT = "verified"
VERIFY_FAILED_PORT = "failed"
VERIFY_INCONCLUSIVE_PORT = "inconclusive"
VERIFY_EVIDENCE_PORT = "evidence"
VERIFY_BRANCH_PORTS = (
    VERIFY_VERIFIED_PORT,
    VERIFY_FAILED_PORT,
    VERIFY_INCONCLUSIVE_PORT,
)
VERIFY_IMPLEMENTATION_PORT = "implementation"
VERIFY_SPEC_PORT = "spec"
#: Reserved executor-result key; the compiler lifts it onto
#: ``wf:<node_id>:__verification`` for ``run.end`` aggregation.
VERIFICATION_RESULT_KEY = "__verification"


class VerificationStatus(StrEnum):
    VERIFIED = "verified"
    FAILED = "failed"
    INCONCLUSIVE = "inconclusive"


class VerifierIssue(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category: str = "unknown"
    severity: str = "error"
    message: str
    location: dict[str, Any] = Field(default_factory=dict)

    @field_validator("category", "severity", "message")
    @classmethod
    def _text(cls, value: str) -> str:
        return str(value).strip() or "unknown"

    def sort_key(self) -> tuple[str, int, int, str]:
        location = self.location
        line = location.get("line")
        column = location.get("column")
        return (
            str(location.get("file") or ""),
            int(line) if isinstance(line, int) else 0,
            int(column) if isinstance(column, int) else 0,
            self.message,
        )


class VerificationResult(BaseModel):
    """Normalized verifier output consumed by ``verify:gate``."""

    model_config = ConfigDict(extra="forbid")

    protocol: str = PROTOCOL
    status: VerificationStatus
    language: SpecLanguage | None = None
    verifier: str = "unknown"
    verifier_version: str | None = None
    duration_ms: int | None = None
    errors: list[VerifierIssue] = Field(default_factory=list)
    counterexample: dict[str, Any] | None = None
    reason: str | None = None
    output_hash: str | None = None
    raw_output: str | None = None

    def bundled(self) -> dict[str, Any]:
        return self.model_dump(mode="json")


def default_verifier_for(language: SpecLanguage) -> str:
    return {
        SpecLanguage.DAFNY: "dafny_verify",
        SpecLanguage.LEAN: "lean_check",
        SpecLanguage.TLA: "tla_model_check",
        SpecLanguage.CEL: "cel_evaluate",
    }[language]


def parse_verifier_selection(params: dict[str, Any], language: SpecLanguage) -> tuple[str, str | None]:
    """Return ``(tool_id, provider)`` for a verify gate's verifier parameter."""
    raw = params.get("verifier")
    if raw is None:
        return default_verifier_for(language), None
    if isinstance(raw, str):
        tool = raw.strip()
        if not tool:
            raise ValueError("verifier must not be blank")
        return tool, None
    if isinstance(raw, dict):
        tool = raw.get("tool")
        provider = raw.get("provider")
        if not isinstance(tool, str) or not tool.strip():
            raise ValueError("verifier must name a tool")
        if provider is not None and (not isinstance(provider, str) or not provider.strip()):
            raise ValueError("verifier.provider must be a non-empty string when set")
        return tool.strip(), provider.strip() if isinstance(provider, str) else None
    raise ValueError("verifier must be a tool id or {tool, provider}")


def _coerce_raw(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError(f"verifier output is not valid JSON: {exc}") from exc
        if not isinstance(parsed, dict):
            raise ValueError("verifier output must be a JSON object")
        return parsed
    raise ValueError(f"verifier output must be an object, got {type(raw).__name__}")


def _int_or_none(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def _normalize_errors(raw: Any) -> list[VerifierIssue]:
    if not isinstance(raw, list):
        return []
    issues: list[VerifierIssue] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        location = item.get("location")
        issues.append(
            VerifierIssue(
                category=item.get("category") or item.get("kind") or "unknown",
                severity=item.get("severity") or "error",
                message=item.get("message") or item.get("text") or "",
                location=location if isinstance(location, dict) else {},
            )
        )
    return sorted(issues, key=lambda issue: issue.sort_key())


def _output_hash(payload: dict[str, Any]) -> str:
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)
    return "sha256:" + hashlib.sha256(blob.encode("utf-8")).hexdigest()


def normalize_verifier_result(raw: Any, *, verifier_fallback: str = "unknown") -> VerificationResult:
    """Normalize a verifier tool result.

    A malformed result becomes ``inconclusive`` with a machine-readable reason;
    it is never treated as a proof failure.
    """
    try:
        payload = _coerce_raw(raw)
    except ValueError as exc:
        return VerificationResult(
            status=VerificationStatus.INCONCLUSIVE,
            verifier=verifier_fallback,
            reason=f"invalid_output: {exc}",
        )

    raw_status = str(payload.get("status") or "").strip().lower()
    try:
        status = VerificationStatus(raw_status)
    except ValueError:
        return VerificationResult(
            status=VerificationStatus.INCONCLUSIVE,
            verifier=str(payload.get("verifier") or verifier_fallback),
            reason=f"invalid_status: {raw_status or '(missing)'}",
            raw_output=json.dumps(payload, ensure_ascii=False)[:MAX_RAW_OUTPUT_CHARS],
        )

    errors = _normalize_errors(payload.get("errors"))
    counterexample = payload.get("counterexample")
    if not isinstance(counterexample, dict):
        counterexample = None
    raw_output = payload.get("raw_output")
    if isinstance(raw_output, str):
        raw_output = raw_output[:MAX_RAW_OUTPUT_CHARS]
    else:
        raw_output = None

    result = VerificationResult(
        protocol=str(payload.get("protocol") or PROTOCOL),
        status=status,
        language=payload.get("language"),
        verifier=str(payload.get("verifier") or verifier_fallback),
        verifier_version=str(payload["verifier_version"]) if payload.get("verifier_version") is not None else None,
        duration_ms=_int_or_none(payload.get("duration_ms")),
        errors=errors,
        counterexample=counterexample,
        reason=str(payload["reason"]) if payload.get("reason") is not None else None,
        output_hash=str(payload["output_hash"]) if payload.get("output_hash") is not None else _output_hash(payload),
        raw_output=raw_output,
    )
    if result.status == VerificationStatus.FAILED and not result.errors and result.reason is None:
        result.reason = "verifier reported failure without structured errors"
    return result


def verification_summary(node_id: str, spec: SpecRef, result: VerificationResult) -> dict[str, Any]:
    """Build the reserved per-node verification summary for ``run.end``."""
    return {
        "node_id": node_id,
        "status": result.status.value,
        "verifier": result.verifier,
        "verifier_version": result.verifier_version,
        "duration_ms": result.duration_ms,
        "spec": spec.to_dict(),
        "error_categories": [{"category": issue.category, "severity": issue.severity} for issue in result.errors],
        "reason": result.reason,
        "output_hash": result.output_hash,
    }


__all__ = [
    "MAX_RAW_OUTPUT_CHARS",
    "PROTOCOL",
    "VERIFY_BRANCH_PORTS",
    "VERIFY_EVIDENCE_PORT",
    "VERIFY_FAILED_PORT",
    "VERIFY_IMPLEMENTATION_PORT",
    "VERIFY_INCONCLUSIVE_PORT",
    "VERIFY_SPEC_PORT",
    "VERIFY_STATUS_PORT",
    "VERIFY_VERIFIED_PORT",
    "VERIFICATION_RESULT_KEY",
    "VerificationResult",
    "VerificationStatus",
    "VerifierIssue",
    "default_verifier_for",
    "normalize_verifier_result",
    "parse_verifier_selection",
    "verification_summary",
]
