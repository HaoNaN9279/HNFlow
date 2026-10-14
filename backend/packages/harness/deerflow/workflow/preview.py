"""Action preview — a read-only description of what a mutating node will do (N10).

Dev plan §21 asks for irreversible operations (overwrite a file, delete a layer,
publish) to be **previewed and confirmed** before they run, with a compensation
action attached.  This module owns the "preview" half; the confirmation half is
:mod:`deerflow.workflow.approval` and the compensation half is
:mod:`deerflow.workflow.undo`.

Design:

- **A preview never mutates anything.**  It reads (stat / hash / config) only,
  because the whole point is to fingerprint the files an action is about to
  touch so a later staleness check can tell whether the world changed while a
  human was deciding.
- **Targets and sources are :class:`~deerflow.assets.ref.AssetRef` values** — the
  N9 identity already carries exactly the fingerprint a preview needs
  (``size`` / ``mtime`` / ``sha256``) and already knows both filesystem worlds
  (host vs sandbox).  No parallel "preview target" type.
- **Only ``observed`` targets are re-verified.**  Each target is a
  :class:`PreviewTarget` pairing an :class:`AssetRef` with an ``observed`` flag:
  an *observed* target was actually inspected (so a missing file is a real
  observation and an appearance during the approval is detectable), while a
  *declared* target merely names a path.  Sandbox targets are declared on
  purpose — fingerprinting one means downloading the whole file (``read_file``
  is text-only, so binary content needs ``download_file``), which is not worth
  paying just to describe a write.  The realistic hazard is the *host* side (a
  human editing a file in the professional application while the approval is
  pending), and host fingerprints are cheap.
- **Previewers are registered next to their executor**
  (``ExecutorRegistration.preview``) and reach the compiler through
  ``CompileContext.previews``, so the compiler never imports the registry.
- **Previewers follow the executor contract** (``(runtime, params, inputs)``)
  and may be sync or async, resolved by the same ``_resolve_executor`` helper.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, ConfigDict, Field

from deerflow.assets.ref import (
    AssetRef,
    asset_ref_from_stat,
    fingerprint_bytes,
    fingerprint_file,
    make_ref,
)

if TYPE_CHECKING:  # pragma: no cover — typing only, keeps this module cycle-free
    from deerflow.workflow.compiler import WorkflowRuntime

# ── Types ─────────────────────────────────────────────────────────────────────

#: A previewer describes one node's effect without performing it.  Same call
#: signature as an executor; may return an awaitable.
Previewer = Callable[["WorkflowRuntime", dict[str, Any], dict[str, Any]], "ActionPreview | None"]

#: How an action can be compensated.
#:
#: - ``backup``   — the engine snapshots the touched paths first (N10 file-level
#:   rollback; works for sandbox and host paths).
#: - ``app_undo`` — the application's own undo/history is used.
#: - ``none``     — nothing can undo this.
RECOVERY_BACKUP = "backup"
RECOVERY_APP_UNDO = "app_undo"
RECOVERY_NONE = "none"


class PreviewTarget(BaseModel):
    """One file an action touches, plus whether the preview actually looked at it.

    ``observed`` is what separates "the preview inspected this path and it was
    *missing*" from "the preview merely named this path".  Without it, a declared
    absence and an uninspected path are the same value (no fingerprint), and a
    file that appeared while the approval was pending could not be caught —
    which is precisely the overwrite hazard an approval exists to prevent.
    """

    model_config = ConfigDict(extra="forbid")

    ref: AssetRef = Field(description="The file's identity (path + fingerprint when observed).")
    observed: bool = Field(default=False, description="Whether the preview actually inspected this path (an observed absence is meaningful).")

    def to_port(self) -> dict[str, Any]:
        return {"ref": self.ref.to_port(), "observed": self.observed}


def observe(ref: AssetRef) -> PreviewTarget:
    """Mark *ref* as inspected (its absence, if any, is a real observation)."""
    return PreviewTarget(ref=ref, observed=True)


def declare(ref: AssetRef) -> PreviewTarget:
    """Mark *ref* as merely named — no claim about its current content."""
    return PreviewTarget(ref=ref, observed=False)


class ActionPreview(BaseModel):
    """What one mutating node action will do, described before it runs.

    Serialised into the approval HumanTask's ``inputs_snapshot`` and returned by
    the read-only preview route, so both a human and the canvas see the same
    shape.
    """

    model_config = ConfigDict(extra="forbid")

    node_id: str = Field(description="Workflow node this preview belongs to.")
    node_type: str = Field(description="Node type value (e.g. 'app:script').")
    action: str = Field(description="Machine-readable action key (e.g. 'overwrite_file').")
    summary: str = Field(description="One-line human-readable description of the effect.")
    reversible: bool = Field(description="Whether the action can be compensated (see ``recovery``).")
    recovery: str = Field(description="Compensation strategy: 'backup' | 'app_undo' | 'none'.")
    sources: list[PreviewTarget] = Field(default_factory=list, description="Read-only inputs the action consumes.")
    targets: list[PreviewTarget] = Field(default_factory=list, description="Files the action creates, overwrites or deletes.")
    risks: list[str] = Field(default_factory=list, description="Conditions the approver should know about.")
    required_confirmations: list[str] = Field(default_factory=list, description="Non-approval gates this action still passes through (e.g. crash_confirm).")

    def to_port(self) -> dict[str, Any]:
        """Return the JSON-safe dict carried in a HumanTask snapshot / API response."""
        return self.model_dump()


def make_preview(
    params: dict[str, Any],
    *,
    action: str,
    summary: str,
    reversible: bool,
    recovery: str,
    sources: list[PreviewTarget] | None = None,
    targets: list[PreviewTarget] | None = None,
    risks: list[str] | None = None,
    required_confirmations: list[str] | None = None,
) -> ActionPreview:
    """Build an :class:`ActionPreview` using the compiler-injected node identity.

    The compiler passes ``node_id`` / ``node_type`` in the previewer's ``params``
    (the same injection ``human:task`` and ``ai:llm_agent`` receive), so a
    previewer never has to know which node it is describing.
    """
    return ActionPreview(
        node_id=str(params.get("node_id") or ""),
        node_type=str(params.get("node_type") or ""),
        action=action,
        summary=summary,
        reversible=reversible,
        recovery=recovery,
        sources=list(sources or []),
        targets=list(targets or []),
        risks=list(risks or []),
        required_confirmations=list(required_confirmations or []),
    )


# ── Observed vs declared refs ─────────────────────────────────────────────────


def is_observed(ref: AssetRef) -> bool:
    """Return whether *ref* carries a fingerprint (i.e. says something about content)."""
    return ref.size is not None or ref.sha256 is not None or ref.mtime is not None


def fingerprint_host_ref(ref: AssetRef) -> AssetRef:
    """Re-inspect a host ref against the filesystem (synchronous I/O).

    A missing file yields a declared-only ref (``size=None``) rather than an
    error, so :func:`diff_targets` can report a disappearance.  The SHA-256 is
    recomputed only when the expected ref carries one — re-hashing a large file
    nobody asked to hash would be a surprise cost.
    """
    try:
        stat_result = os.stat(ref.path)
    except OSError:
        return make_ref(ref.path, scope=ref.scope)
    sha256 = fingerprint_file(ref.path) if ref.sha256 is not None else None
    return asset_ref_from_stat(ref.path, stat_result, scope=ref.scope, sha256=sha256)


def fingerprint_sandbox_ref(ref: AssetRef, sandbox: Any) -> AssetRef:
    """Re-inspect a sandbox ref by downloading it (synchronous I/O).

    The abstract ``Sandbox`` exposes no ``stat``, so content is the only
    observable — which is exactly why sandbox targets are declared without
    fingerprints in the first place.  ``mtime`` stays unset.
    """
    try:
        data = sandbox.download_file(ref.path)
    except OSError:
        return make_ref(ref.path, scope=ref.scope)
    return make_ref(
        ref.path,
        scope=ref.scope,
        size=len(data),
        sha256=fingerprint_bytes(data) if ref.sha256 is not None else None,
    )


def build_target_resolver(sandbox: Any | None = None) -> Callable[[AssetRef], AssetRef]:
    """Return a resolver that re-inspects host refs (and sandbox refs when given)."""

    def _resolve(ref: AssetRef) -> AssetRef:
        if ref.scope == "host":
            return fingerprint_host_ref(ref)
        if sandbox is None:
            raise RuntimeError(f"no sandbox available to re-inspect {ref.path!r}")
        return fingerprint_sandbox_ref(ref, sandbox)

    return _resolve


def diff_targets(expected: list[PreviewTarget], resolve: Callable[[AssetRef], AssetRef]) -> list[str]:
    """Compare *expected* targets against their current state.

    Returns one human-readable note per mismatch (empty list = unchanged, so the
    approved action can proceed).  Only ``observed`` targets are re-inspected: a
    declared target names a path without asserting anything about its content,
    while an observed one claims either a fingerprint *or* a real absence.

    Comparison order for an observed target: presence, then ``sha256`` (when both
    sides have one), then ``size``, then ``mtime`` (the weakest signal, and the
    only one available on filesystems with coarse timestamps).
    """
    notes: list[str] = []
    for target in expected:
        if not target.observed:
            continue
        want = target.ref
        try:
            now = resolve(want)
        except Exception as exc:  # noqa: BLE001 — a resolver failure is a reported mismatch, not a crash
            notes.append(f"{want.path}: cannot re-inspect ({exc})")
            continue

        if want.size is None and now.size is None:
            continue  # still absent — unchanged
        if want.size is None and now.size is not None:
            notes.append(f"{want.path}: appeared since the preview ({now.size} bytes)")
            continue
        if want.size is not None and now.size is None:
            notes.append(f"{want.path}: disappeared since the preview")
            continue
        if want.sha256 is not None and now.sha256 is not None:
            if want.sha256 != now.sha256:
                notes.append(f"{want.path}: content changed since the preview (sha256 {want.sha256[:12]}… → {now.sha256[:12]}…)")
            continue
        if want.size != now.size:
            notes.append(f"{want.path}: size changed since the preview ({want.size} → {now.size} bytes)")
            continue
        if want.mtime is not None and now.mtime is not None and abs(want.mtime - now.mtime) > 1e-6:
            notes.append(f"{want.path}: modified since the preview (mtime {want.mtime} → {now.mtime})")
    return notes


__all__ = [
    "ActionPreview",
    "PreviewTarget",
    "Previewer",
    "RECOVERY_APP_UNDO",
    "RECOVERY_BACKUP",
    "RECOVERY_NONE",
    "build_target_resolver",
    "declare",
    "diff_targets",
    "fingerprint_host_ref",
    "fingerprint_sandbox_ref",
    "is_observed",
    "make_preview",
    "observe",
]
