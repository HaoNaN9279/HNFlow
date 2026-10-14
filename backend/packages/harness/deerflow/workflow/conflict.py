"""Optimistic conflict detection for a node's own working window (N10b, §17 / §21).

Dev plan §21 lists **conflict detection** beside preview/approval and preemption.
N10's staleness guard already covers the *human decision* window: a preview frozen
at approval time is re-inspected before the executor is allowed to run.  What is
left is the window a node owns itself — while it waits (for a person to release a
local application, for an admission slot), the host files it declared can change
under it.

This module is that second, cheaper guard:

- :func:`conflicts_requested` reads the opt-in (``params.detect_conflicts``);
- :func:`observe_refs` takes the snapshot at the top of the node;
- :meth:`ConflictGuard.verify` re-inspects and :meth:`ConflictGuard.check` refuses
  the node with a precise list of what changed.

Deliberate boundaries:

- **Host refs only.**  A sandbox file's other writer would be the engine itself,
  and observing sandbox content means downloading the whole file on every
  opted-in node — the same call N10 made when it chose to *declare* rather than
  fingerprint sandbox targets.  Sandbox refs are reported as unverifiable, never
  silently treated as unchanged.
- **A guard, not a lock.**  One snapshot, one re-check immediately before the
  mutation.  It catches a change during a wait; it cannot catch one in the
  microseconds between the re-check and the write, and it does not pretend to.
- **No attribution heuristics.**  "This file changed after we looked, so we
  refuse" is a fact the engine can prove.  "This file changed, so a *human* did
  it" is not — a wrong accusation is worse than no conflict report at all.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Any

from deerflow.assets.ref import AssetRef, asset_ref_from_stat, fingerprint_file, make_ref
from deerflow.workflow.preview import PreviewTarget, build_target_resolver, diff_targets, observe
from deerflow.workflow.registry import WorkflowExecutionError

logger = logging.getLogger(__name__)

#: Node param that arms the guard.
CONFLICT_PARAM = "detect_conflicts"


def conflicts_requested(params: dict[str, Any]) -> bool:
    """Whether this node asked for a conflict re-check (opt-in, literal ``True``)."""
    return params.get(CONFLICT_PARAM) is True


class WorkflowConflictError(WorkflowExecutionError):
    """A declared target changed under a node while it was working (N10b).

    Distinct from a plain execution error so the run failure says *why*: this is
    not a bug in the node, it is another actor having touched the same files —
    which is exactly the situation the N7 retry/backoff path should not blindly
    retry (the human is still there).
    """

    def __init__(self, label: str, notes: list[str], *, unverifiable: list[str] | None = None) -> None:
        self.label = label
        self.notes = list(notes)
        self.unverifiable = list(unverifiable or [])
        detail = "; ".join(notes) if notes else "targets changed"
        skipped = f" (not verified: {', '.join(self.unverifiable)})" if self.unverifiable else ""
        super().__init__(f"{label}: {len(notes)} target(s) changed while this node was waiting: {detail}{skipped}")


def observe_host_ref(ref: AssetRef) -> AssetRef:
    """Fingerprint a host path *including its content*.

    Unlike the approval preview (which hashes only when the caller asked for it),
    conflict detection hashes by default: a rewrite with the same size in the same
    second is exactly what a person working in the application produces, and a
    size+mtime check would miss it.  The caller opted in, so the double read is
    the price of a check that can actually see the change.
    """
    try:
        stat_result = os.stat(ref.path)
    except OSError:
        return make_ref(ref.path, scope=ref.scope)
    return asset_ref_from_stat(ref.path, stat_result, scope=ref.scope, sha256=fingerprint_file(ref.path))


def observe_refs(refs: list[AssetRef], *, sandbox: Any | None = None) -> tuple[list[PreviewTarget], list[str]]:
    """Observe host refs; return ``(observed, unverifiable_paths)``.

    A host path that is missing stays observable on purpose: the snapshot records
    *"absent"* as a real observation, so the file appearing later is a change the
    re-check can catch.  Sandbox refs cannot be observed without downloading them,
    so they come back as unverifiable and are named in the refusal.
    """
    observed: list[PreviewTarget] = []
    unverifiable: list[str] = []
    for ref in refs:
        if ref.scope == "host":
            observed.append(observe(observe_host_ref(ref)))
        else:
            unverifiable.append(ref.path)
    return observed, unverifiable


@dataclass
class ConflictGuard:
    """One snapshot of a node's declared targets, re-checked before it mutates."""

    label: str = ""
    verified: list[PreviewTarget] = field(default_factory=list)
    unverifiable: list[str] = field(default_factory=list)

    @classmethod
    def snapshot(cls, refs: list[AssetRef], *, sandbox: Any | None = None, label: str = "") -> ConflictGuard:
        """Take the snapshot the re-check will compare against."""
        verified, unverifiable = observe_refs(refs, sandbox=sandbox)
        return cls(label=label, verified=verified, unverifiable=unverifiable)

    @property
    def size(self) -> int:
        """How many targets this guard can actually re-check."""
        return len(self.verified)

    def verify(self) -> list[str]:
        """Re-inspect the observed targets; return one note per change."""
        if not self.verified:
            return []
        # Observed refs are host-only by construction (see the module docstring),
        # so no sandbox is needed to re-inspect them.
        return diff_targets(self.verified, build_target_resolver())

    def check(self) -> None:
        """Refuse the node when anything it declared changed.

        Raises:
            WorkflowConflictError: at least one observed target changed.
        """
        notes = self.verify()
        if notes:
            raise WorkflowConflictError(self.label, notes, unverifiable=self.unverifiable)
        if not self.verified and self.unverifiable:
            # The opt-in did nothing: say so, so an operator does not read "the
            # node succeeded" as "the check passed".
            logger.warning(
                "%s: %s requested but no target could be observed (sandbox paths are not re-inspectable): %s",
                self.label or "node",
                CONFLICT_PARAM,
                ", ".join(self.unverifiable),
            )


__all__ = [
    "CONFLICT_PARAM",
    "ConflictGuard",
    "WorkflowConflictError",
    "conflicts_requested",
    "observe_host_ref",
    "observe_refs",
]
