"""Data-transformation workflow executors.

Each executor follows the ``Executor`` contract:
``(runtime: WorkflowRuntime, params: dict, inputs: dict) -> dict``.

All data executors are **idempotent** — repeated execution with the same
inputs produces the same outputs.  ``data:file`` write mode is the exception:
it checks ``crash_confirm`` internally before writing.

``preview_file`` (N10) describes a write *before* it happens, for the approval
gate; read mode has nothing to preview.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from deerflow.assets.ref import make_ref, scope_for_virtual_path
from deerflow.sandbox import tools as sandbox_tools
from deerflow.workflow.compensation import Compensation, rollback_requested
from deerflow.workflow.compiler import WorkflowRuntime
from deerflow.workflow.preview import RECOVERY_BACKUP, ActionPreview, declare, make_preview
from deerflow.workflow.registry import WorkflowExecutionError

logger = logging.getLogger(__name__)

# ── data:assign ──────────────────────────────────────────────────────────────


def exec_assign(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """Static value assignment or input pass-through.

    If ``params.value`` is present it becomes the output; otherwise the
    value arriving on the ``in`` input port is forwarded unchanged.
    """
    if "value" in params:
        return {"out": params["value"]}
    return {"out": inputs.get("in")}


# ── data:shared ──────────────────────────────────────────────────────────────

#: Reserved executor-result key: the compiler lifts each entry onto the
#: ``wf:shared:<name>`` channel (N14 shared workspace).
SHARED_WRITES_RESULT_KEY = "__shared_writes"


def exec_shared(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """Read / write / append a workflow-level shared variable (N14 blackboard).

    ``params.operation`` is ``read`` / ``write`` / ``append`` and ``params.name``
    names the variable.  A ``read`` exposes the current value on ``out``.  A
    ``write`` / ``append`` puts the value into the reserved ``__shared_writes``
    result key (lifted by the compiler onto ``wf:shared:<name>``); the value is
    ``params.value`` when that key is present, else the ``in`` input port.  The
    variable's ``array`` / ``overwrite`` / ``conflict`` policy is applied by the
    channel (reducer vs default), not here.
    """
    operation = params.get("operation")
    name = params.get("name")
    if operation not in ("read", "write", "append"):
        raise WorkflowExecutionError(f"data:shared: unsupported operation {operation!r}")
    if not isinstance(name, str) or not name:
        raise WorkflowExecutionError("data:shared: missing required param 'name'")

    shared_key = f"wf:shared:{name}"
    if operation == "read":
        return {"out": runtime.state.get(shared_key)}

    value = params["value"] if "value" in params else inputs.get("in")
    return {"out": value, SHARED_WRITES_RESULT_KEY: {name: value}}


# ── data:convert ─────────────────────────────────────────────────────────────


def exec_convert(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """Type conversion via ``params.to``.

    Supported target types: ``bool``, ``int``, ``float``, ``str``.
    The input value is read from the ``in`` port.
    """
    target = params.get("to", "str")
    raw = inputs.get("in")

    if target == "bool":
        return {"out": bool(raw)}
    if target == "int":
        return {"out": int(raw) if raw is not None else 0}
    if target == "float":
        return {"out": float(raw) if raw is not None else 0.0}
    if target == "str":
        return {"out": str(raw)}

    raise ValueError(f"data:convert: unsupported target type {target!r}")


# ── data:json ────────────────────────────────────────────────────────────────


def exec_json(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """JSON stringify or parse via ``params.operation``.

    ``stringify`` — ``json.dumps(inputs.in)``
    ``parse``    — ``json.loads(inputs.in)``
    """
    operation = params.get("operation", "stringify")
    raw = inputs.get("in")

    if operation == "stringify":
        return {"out": json.dumps(raw)}
    if operation == "parse":
        if isinstance(raw, str):
            return {"out": json.loads(raw)}
        return {"out": raw}  # already a parsed object — pass through

    raise ValueError(f"data:json: unsupported operation {operation!r}")


# ── data:regex ───────────────────────────────────────────────────────────────


def exec_regex(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """Regular-expression matching via ``params.pattern``.

    Optional ``params.group`` (int or string name) extracts a specific
    capture group; without it the full match string is returned.
    """
    pattern = params.get("pattern")
    if not pattern:
        raise ValueError("data:regex: missing required param 'pattern'")
    raw = str(inputs.get("in", ""))

    match = re.search(pattern, raw)
    if match is None:
        return {"out": None}

    group = params.get("group")
    if group is not None:
        try:
            return {"out": match.group(group)}
        except IndexError:
            return {"out": None}
    return {"out": match.group()}


# ── data:file ────────────────────────────────────────────────────────────────


async def exec_file(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """Read or write a file through the sandbox.

    ``params.operation``: ``"read"`` (default) or ``"write"``.
    ``params.path``: virtual file path (required).
    Read mode: optional ``params.start_line`` / ``params.end_line``.
    Write mode (requires ``crash_confirm``): ``params.content`` or
    ``inputs.in`` as fallback; optional ``params.append`` (default False).

    The executor is registered as idempotent (read is the primary use
    case).  Write mode performs an internal crash-confirmation check, and
    honours ``params.rollback_on_failure`` (N10) by snapshotting the target
    before writing and restoring it if the operation fails.
    """
    operation: str = params.get("operation", "read")
    path: str = params.get("path", "")
    if not path:
        raise WorkflowExecutionError("data:file: missing required param 'path'")

    # Write mode: crash_confirm is a pre-condition checked *before*
    # acquiring the sandbox (the executor is registered as idempotent
    # because read is the primary use case; write adds its own guard).
    if operation == "write" and params.get("crash_confirm") is not True:
        raise WorkflowExecutionError("data:file (write): requires crash_confirm=true (file mutation is non-idempotent)")

    # Acquire sandbox (duck-type compatible with ensure_sandbox_initialized).
    sandbox = sandbox_tools.ensure_sandbox_initialized(runtime)  # type: ignore[arg-type]

    if operation == "read":
        start_line: int | None = params.get("start_line")
        end_line: int | None = params.get("end_line")
        content = sandbox.read_file(path, start_line=start_line, end_line=end_line)
        return {"out": content}

    if operation == "write":
        content = params.get("content") or inputs.get("in", "")
        append: bool = bool(params.get("append", False))
        scope = scope_for_virtual_path(path) or "workspace"
        target = make_ref(path, scope=scope)  # type: ignore[arg-type]

        compensation = await Compensation.prepare(
            runtime,
            node_id=str(params.get("node_id") or ""),
            node_label="data:file (write)",
            targets=[target],
            sandbox=sandbox,
            enabled=rollback_requested(params),
        )
        try:
            sandbox.write_file(path, str(content), append=append)
        except Exception as exc:
            await compensation.rollback(reason=str(exc) or type(exc).__name__)
            raise
        await compensation.commit(detail=f"{'appended to' if append else 'wrote'} {target.path}")
        return {"out": content}

    raise WorkflowExecutionError(f"data:file: unsupported operation {operation!r}")


# ── data:file preview (N10) ───────────────────────────────────────────────────


def preview_file(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> ActionPreview | None:
    """Describe a ``data:file`` write; return ``None`` for the read-only mode.

    The target is a *declared* sandbox ref (no fingerprint): the abstract
    ``Sandbox`` has no ``stat``, so observing content would mean downloading the
    whole existing file.  The summary therefore reports what will be written
    (length only — never the content, which may hold a secret the approval row
    must not retain) rather than what is being replaced.
    """
    if str(params.get("operation", "read")).lower() != "write":
        return None

    path = str(params.get("path") or "").strip()
    if not path:
        raise WorkflowExecutionError("data:file: missing required param 'path'")

    scope = scope_for_virtual_path(path) or "workspace"
    target = make_ref(path, scope=scope)  # type: ignore[arg-type]

    content = params.get("content")
    if content is None:
        content = inputs.get("in", "")
    length = len(str(content))
    append = bool(params.get("append", False))

    risks: list[str] = []
    if append:
        summary = f"Append {length} characters to {target.path}"
        risks.append("the appended text becomes part of the existing file; a rollback restores the pre-append content")
    else:
        summary = f"Overwrite {target.path} with {length} characters"
        risks.append("any existing content is replaced")

    return make_preview(
        params,
        action="append_file" if append else "overwrite_file",
        summary=summary,
        reversible=True,
        recovery=RECOVERY_BACKUP,
        targets=[declare(target)],
        risks=risks,
        required_confirmations=["crash_confirm"],
    )
