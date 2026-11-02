"""``data:spec`` — author, revise, freeze, resolve and lint specifications."""

from __future__ import annotations

from typing import Any

from deerflow.workflow.compiler import WorkflowRuntime
from deerflow.workflow.registry import WorkflowExecutionError
from deerflow.workflow.spec import SpecLanguage, SpecRef, parse_spec_ref
from deerflow.workflow.verification import VerifierIssue
from deerflow.workflow.verifiers.spec_lint import lint_spec_content

_OPERATIONS = frozenset({"create", "revise", "freeze", "resolve", "lint"})


def _repo(runtime: WorkflowRuntime) -> Any:
    repo = (runtime.context or {}).get("spec_repo")
    if repo is None:
        raise WorkflowExecutionError("data:spec requires a 'spec_repo' in runtime context (spec persistence is unavailable)")
    return repo


def _user(runtime: WorkflowRuntime) -> str:
    return str((runtime.context or {}).get("user_id") or "")


def _text(value: Any, *, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise WorkflowExecutionError(f"data:spec: '{field}' must be a non-empty string")
    return value


def _ref_from_row(row: dict[str, Any]) -> SpecRef:
    return SpecRef(
        spec_id=row["spec_id"],
        revision=int(row["revision"]),
        content_hash=str(row["content_hash"]),
        language=SpecLanguage(row["language"]),
        title=row.get("title"),
    )


def _input_ref(params: dict[str, Any], inputs: dict[str, Any]) -> SpecRef | None:
    raw = inputs.get("spec") or params.get("spec_ref") or params.get("spec")
    if raw is None:
        return None
    try:
        return parse_spec_ref(raw)
    except ValueError as exc:
        raise WorkflowExecutionError(f"data:spec: {exc}") from exc


async def exec_spec(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """Execute one specification lifecycle operation.

    Operations are explicit; an unknown operation fails rather than guessing.
    A freeze in a graph is expected to carry ``approved_by`` or
    ``approval_task_id`` from a preceding human task; the API is the operator
    escape hatch.
    """
    operation = str(params.get("operation") or "").strip()
    if operation not in _OPERATIONS:
        raise WorkflowExecutionError(f"data:spec: unsupported operation {operation!r}; expected one of {sorted(_OPERATIONS)}")
    repo = _repo(runtime)
    user_id = _user(runtime)

    if operation == "create":
        content = _text(inputs.get("content") or params.get("content"), field="content")
        language_raw = inputs.get("language") or params.get("language") or "dafny"
        try:
            language = SpecLanguage(str(language_raw))
        except ValueError as exc:
            raise WorkflowExecutionError(f"data:spec: unknown language {language_raw!r}") from exc
        name = str(params.get("name") or params.get("title") or "Specification")
        row = await repo.create(
            user_id=user_id,
            name=name,
            language=language,
            content=content,
            title=params.get("title"),
            metadata=params.get("metadata") if isinstance(params.get("metadata"), dict) else None,
        )
        ref = _ref_from_row(row)
        return {"out": ref.to_dict(), "spec": ref.to_dict()}

    ref = _input_ref(params, inputs)

    if operation == "revise":
        if ref is None:
            raise WorkflowExecutionError("data:spec: revise requires params.spec_ref or a 'spec' input")
        content = _text(inputs.get("content") or params.get("content"), field="content")
        row = await repo.add_revision(
            ref.spec_id,
            user_id=user_id,
            content=content,
            title=params.get("title") or ref.title,
            metadata=params.get("metadata") if isinstance(params.get("metadata"), dict) else None,
        )
        new_ref = _ref_from_row(row)
        return {"out": new_ref.to_dict(), "spec": new_ref.to_dict()}

    if operation == "resolve":
        if ref is None:
            raise WorkflowExecutionError("data:spec: resolve requires params.spec_ref or a 'spec' input")
        row = await repo.resolve_ref(ref, user_id=user_id)
        resolved = _ref_from_row(row)
        return {"out": resolved.to_dict(), "spec": resolved.to_dict()}

    if operation == "freeze":
        if ref is None:
            raise WorkflowExecutionError("data:spec: freeze requires params.spec_ref or a 'spec' input")
        approved_by = str(params.get("approved_by") or inputs.get("approved_by") or "").strip()
        if not approved_by:
            raise WorkflowExecutionError("data:spec: freeze requires approved_by (human approval must be recorded)")
        row = await repo.freeze(
            ref.spec_id,
            ref.revision,
            user_id=user_id,
            approved_by=approved_by,
            approval_task_id=params.get("approval_task_id"),
        )
        frozen = _ref_from_row(row)
        return {"out": frozen.to_dict(), "spec": frozen.to_dict()}

    # lint
    if ref is not None:
        row = await repo.resolve_ref(ref, user_id=user_id)
        language = SpecLanguage(row["language"])
        content = str(row["content"])
    else:
        content = _text(inputs.get("content") or params.get("content"), field="content")
        language_raw = inputs.get("language") or params.get("language") or "dafny"
        try:
            language = SpecLanguage(str(language_raw))
        except ValueError as exc:
            raise WorkflowExecutionError(f"data:spec: unknown language {language_raw!r}") from exc
    issues: list[VerifierIssue] = lint_spec_content(language, content)
    payload = [issue.model_dump(mode="json") for issue in issues]
    return {"out": payload, "issues": payload}


__all__ = ["exec_spec"]
