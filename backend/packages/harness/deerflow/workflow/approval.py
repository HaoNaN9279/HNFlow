"""Human approval gate for irreversible node actions (N10, dev plan §21).

An irreversible node declares ``params.require_approval = true``.  Before it
runs, its effect is described by the node type's previewer
(:mod:`deerflow.workflow.preview`), a HumanTask of kind ``approval`` is created,
and the graph suspends through LangGraph's ``interrupt()`` — exactly the
mechanism ``human:task`` uses.  On resume:

- **approved** → the preview's *observed* targets are re-inspected; if anything
  changed while the human was deciding (the file was edited, replaced or
  deleted), the node fails with an explicit staleness error instead of running
  against a world the approver never saw.  Otherwise execution proceeds.
- **rejected** → ``params.on_reject`` decides: ``fail`` (default) raises, so the
  run error is actionable and the scheduler's retry/DLQ path (N7) can act on it;
  ``skip`` returns no outputs and the graph continues — for workflows whose
  downstream branches tolerate an omitted result.

**The stored preview is authoritative.**  LangGraph re-executes a node from its
head when the graph resumes, so the previewer must run *only* on first execution:
rebuilding the preview after the human decided would describe the changed world
and silently accept exactly the drift the staleness check exists to catch.  The
task's ``inputs_snapshot.preview`` is the frozen description the human approved,
and it is what gets re-verified on resume.

Why the gate lives here and not in each executor: the preview and the execution
must describe the *same* action, and the only way to guarantee that is to keep
them in one place.  Putting the gate in the compiler's node wrapper means every
executor gets it for free, no executor learns about approvals, and the
``crash_confirm`` gate (which stays exactly where it is, inside the mutating
executors) becomes the second, independent confirmation the human already saw in
``ActionPreview.required_confirmations``.

Not supported inside subgraphs: a subgraph compiles with ``checkpointer=None``,
where ``interrupt()`` cannot suspend, so a missing ``human_task_repo`` is an
explicit error rather than a silent half-approval.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
from typing import TYPE_CHECKING, Any

from langgraph.types import interrupt

from deerflow.workflow.preview import ActionPreview, Previewer, build_target_resolver, diff_targets
from deerflow.workflow.registry import WorkflowExecutionError

if TYPE_CHECKING:  # pragma: no cover — typing only
    from deerflow.workflow.compiler import WorkflowRuntime

logger = logging.getLogger(__name__)

#: ``params.on_reject`` values.
ON_REJECT_FAIL = "fail"
ON_REJECT_SKIP = "skip"
ON_REJECT_VALUES: frozenset[str] = frozenset({ON_REJECT_FAIL, ON_REJECT_SKIP})

_DESCRIPTION_LIMIT = 500

#: What an approval task asks the human to submit.  Declared as a node-less
#: ``output_spec`` so the shared HumanTask submission validator
#: (``validate_human_task_submission``) and the API/tool paths that use it work
#: unchanged: one required boolean port, constrained by the shared ``enum`` rule.
APPROVAL_OUTPUT_SPEC: dict[str, Any] = {
    "ports": [
        {
            "name": "decision",
            "type": "bool",
            "required": True,
            "description": "true to run the action, false to reject it",
        }
    ]
}
APPROVAL_VALIDATION_RULES: dict[str, Any] = {"enum": {"decision": {"enum": [True, False]}}}

#: Marker stored on the task row's ``inputs_snapshot`` (the gate also sets the
#: row's ``kind`` column once it exists).
APPROVAL_SNAPSHOT_KIND = "approval"


class ApprovalDecision:
    """The human's answer for one approval."""

    def __init__(self, *, approved: bool, note: str | None = None, task_id: str | None = None) -> None:
        self.approved = approved
        self.note = note
        self.task_id = task_id

    @classmethod
    def from_resume(cls, value: Any, *, task_id: str | None = None) -> ApprovalDecision:
        """Parse an ``interrupt()`` resume payload.

        Accepted shapes: ``{"decision": bool, "note": str}`` (canonical, what the
        task's ``output_spec`` declares) and ``{"approved": bool}`` (alias).
        ``{"__skip": True}`` — the shared "the user declined to act" sentinel —
        counts as **rejected**, never as approval: declining to decide must not
        execute an irreversible action.
        """
        if not isinstance(value, dict):
            return cls(approved=False, note="no decision submitted", task_id=task_id)
        if value.get("__skip") is True:
            return cls(approved=False, note="skipped by the user", task_id=task_id)

        raw = value.get("decision", value.get("approved"))
        note = value.get("note")
        if not isinstance(raw, bool):
            return cls(approved=False, note="no decision submitted", task_id=task_id)
        return cls(approved=raw, note=note if isinstance(note, str) else None, task_id=task_id)


def approval_required(params: dict[str, Any]) -> bool:
    """Whether *params* ask for human approval before this node runs."""
    return params.get("require_approval") is True


def on_reject_policy(params: dict[str, Any]) -> str:
    """Resolve ``params.on_reject`` (default ``fail``), rejecting unknown values."""
    value = params.get("on_reject", ON_REJECT_FAIL)
    if value not in ON_REJECT_VALUES:
        raise WorkflowExecutionError(f"on_reject must be one of {sorted(ON_REJECT_VALUES)}, got {value!r}")
    return str(value)


def verify_preview_targets(preview: ActionPreview, *, sandbox: Any | None = None) -> list[str]:
    """Re-inspect the preview's observed sources/targets; return mismatch notes.

    Sources are verified too: an ``import`` whose host source changed under the
    approver would otherwise import content nobody approved.  Declared targets
    (sandbox writes) are skipped — see :mod:`deerflow.workflow.preview` for why
    they carry no fingerprint.

    Synchronous I/O: callers must offload it (the gate uses ``asyncio.to_thread``).
    """
    observed = [t for t in (*preview.sources, *preview.targets) if t.observed]
    if not observed:
        return []
    return diff_targets(observed, build_target_resolver(sandbox))


async def _build_preview(previewer: Previewer, runtime: WorkflowRuntime, node_id: str, node_type: str, params: dict[str, Any], inputs: dict[str, Any]) -> ActionPreview | None:
    """Run a previewer with the node identity injected (executor-param convention)."""
    preview_params = {**params, "node_id": node_id, "node_type": node_type}
    preview = previewer(runtime, preview_params, inputs)
    if inspect.isawaitable(preview):
        preview = await preview
    return preview


class ApprovalRecord:
    """One approval task paired with the preview it froze."""

    def __init__(self, *, task_id: str, preview: ActionPreview) -> None:
        self.task_id = task_id
        self.preview = preview


def _stored_preview(row: dict[str, Any]) -> ActionPreview | None:
    """Rebuild the preview frozen on an existing approval task, if it carries one."""
    snapshot = row.get("inputs_snapshot")
    if not isinstance(snapshot, dict):
        return None
    payload = snapshot.get("preview")
    if not isinstance(payload, dict):
        return None
    try:
        return ActionPreview.model_validate(payload)
    except Exception:  # noqa: BLE001 — a malformed legacy snapshot must not wedge the node
        logger.warning("approval task %s carries an unreadable preview snapshot", row.get("id"), exc_info=True)
        return None


def _require_repo(runtime: WorkflowRuntime, node_id: str) -> Any:
    repo = (runtime.context or {}).get("human_task_repo")
    if repo is None:
        raise WorkflowExecutionError(f"node '{node_id}': require_approval needs a human_task_repo in runtime context (approvals are not supported inside subgraphs or without repository injection)")
    return repo


async def load_or_create_approval(
    runtime: WorkflowRuntime,
    *,
    node_id: str,
    node_type: str,
    previewer: Previewer,
    params: dict[str, Any],
    inputs: dict[str, Any],
) -> ApprovalRecord:
    """Resolve the approval task for this node, creating it (and its preview) once.

    Idempotency mirrors ``human:task``: LangGraph re-executes the node from its
    head on resume, so an existing row for ``(run_id, node_id)`` is reused and
    its stored preview is returned — the approval is *about that snapshot*.
    """
    repo = _require_repo(runtime, node_id)
    context = runtime.context or {}
    user_id = str(context.get("user_id") or "")
    run_id = str(context.get("run_id") or "")

    existing = await repo.find_by_run_and_node(run_id=run_id, node_id=node_id)
    if existing is not None:
        stored = _stored_preview(existing)
        if stored is not None:
            return ApprovalRecord(task_id=str(existing["id"]), preview=stored)

    preview = await _build_preview(previewer, runtime, node_id, node_type, params, inputs)
    if preview is None:
        raise WorkflowExecutionError(f"node '{node_id}': require_approval is set but node type '{node_type}' declared nothing to preview")

    if existing is not None:
        # A row exists but carries no readable preview (legacy or hand-written):
        # reuse the task so the human's queued item is not duplicated.
        return ApprovalRecord(task_id=str(existing["id"]), preview=preview)

    row = await repo.create(
        user_id=user_id,
        workflow_run_id=run_id,
        node_id=node_id,
        kind=APPROVAL_SNAPSHOT_KIND,
        description=f"[approval] {preview.summary}"[:_DESCRIPTION_LIMIT],
        inputs_snapshot={"kind": APPROVAL_SNAPSHOT_KIND, "preview": preview.to_port()},
        output_spec=APPROVAL_OUTPUT_SPEC,
        validation_rules=APPROVAL_VALIDATION_RULES,
        checkpoint_ref=None,
    )
    return ApprovalRecord(task_id=str(row["id"]), preview=preview)


async def request_approval(
    runtime: WorkflowRuntime,
    *,
    node_id: str,
    node_type: str,
    preview: ActionPreview,
) -> ApprovalDecision:
    """Create (or reuse) the approval HumanTask and suspend until it resolves.

    Convenience wrapper for callers that already hold a preview; the compiler gate
    uses :func:`load_or_create_approval` so the stored snapshot wins on resume.
    """
    repo = _require_repo(runtime, node_id)
    context = runtime.context or {}
    user_id = str(context.get("user_id") or "")
    run_id = str(context.get("run_id") or "")
    payload = preview.to_port()

    existing = await repo.find_by_run_and_node(run_id=run_id, node_id=node_id)
    if existing is not None:
        task_id = str(existing["id"])
    else:
        row = await repo.create(
            user_id=user_id,
            workflow_run_id=run_id,
            node_id=node_id,
            kind=APPROVAL_SNAPSHOT_KIND,
            description=f"[approval] {preview.summary}"[:_DESCRIPTION_LIMIT],
            inputs_snapshot={"kind": APPROVAL_SNAPSHOT_KIND, "preview": payload},
            output_spec=APPROVAL_OUTPUT_SPEC,
            validation_rules=APPROVAL_VALIDATION_RULES,
            checkpoint_ref=None,
        )
        task_id = str(row["id"])

    resume = interrupt({"type": APPROVAL_SNAPSHOT_KIND, "task_id": task_id, "node_id": node_id, "node_type": node_type, "preview": payload})
    return ApprovalDecision.from_resume(resume, task_id=task_id)


async def run_approval(
    runtime: WorkflowRuntime,
    *,
    node_id: str,
    node_type: str,
    previewer: Previewer,
    params: dict[str, Any],
    inputs: dict[str, Any],
) -> ApprovalDecision:
    """Preview → suspend for approval → verify the approved preview is still fresh.

    The **stored** preview is authoritative, not a freshly built one.  LangGraph
    re-executes a node from its head when the graph resumes, so rebuilding the
    preview here would describe the world *after* the human decided — and would
    silently accept exactly the change the staleness check exists to catch.  The
    previewer therefore runs only when no approval task exists yet (i.e. on the
    first execution), and the snapshot the human saw is what gets verified.

    Raises :class:`WorkflowExecutionError` when the node type produced no preview
    on first execution (an approvable node must be able to describe itself).
    """
    record = await load_or_create_approval(runtime, node_id=node_id, node_type=node_type, previewer=previewer, params=params, inputs=inputs)

    resume = interrupt({"type": APPROVAL_SNAPSHOT_KIND, "task_id": record.task_id, "node_id": node_id, "node_type": node_type, "preview": record.preview.to_port()})
    decision = ApprovalDecision.from_resume(resume, task_id=record.task_id)
    if not decision.approved:
        return decision

    sandbox = _sandbox_for_verification(runtime, record.preview)
    notes = await asyncio.to_thread(verify_preview_targets, record.preview, sandbox=sandbox)
    if notes:
        detail = "; ".join(notes)
        raise WorkflowExecutionError(f"node '{node_id}': the approved action is no longer valid ({detail}); re-run it so a fresh preview can be confirmed")
    return decision


def _sandbox_for_verification(runtime: WorkflowRuntime, preview: ActionPreview) -> Any | None:
    """Acquire the sandbox only when an observed target needs it.

    Previewers declare sandbox targets rather than observing them (no ``stat`` in
    the abstract ``Sandbox``), so in practice this returns ``None`` and the gate
    never touches the sandbox; the path exists so a future previewer that *does*
    observe a sandbox ref is verified rather than silently skipped.
    """
    needs_sandbox = any(t.observed and t.ref.scope != "host" for t in (*preview.sources, *preview.targets))
    if not needs_sandbox:
        return None
    from deerflow.sandbox import tools as sandbox_tools  # deferred: keeps the approval module import-light

    return sandbox_tools.ensure_sandbox_initialized(runtime)  # type: ignore[arg-type]


__all__ = [
    "APPROVAL_OUTPUT_SPEC",
    "APPROVAL_SNAPSHOT_KIND",
    "APPROVAL_VALIDATION_RULES",
    "ON_REJECT_FAIL",
    "ON_REJECT_SKIP",
    "ON_REJECT_VALUES",
    "ApprovalDecision",
    "ApprovalRecord",
    "approval_required",
    "load_or_create_approval",
    "on_reject_policy",
    "request_approval",
    "run_approval",
    "verify_preview_targets",
]
