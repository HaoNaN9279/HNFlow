"""Combining the two N11 halves into one environment report (pure).

The Gateway endpoint, the CLI and the startup check all answer the same question
— "is this machine ready for what we have declared?" — from the same two inputs:
the capability-group/app requirement probe
(:class:`~deerflow.environment.requirements.EnvironmentStatus`) and the data
directory layout check (``Paths.check_data_dirs``).

This module only *combines* them, on purpose.  It resolves no configuration and
imports nothing from ``deerflow.config``: ``deerflow.environment.spec`` is
imported by ``deerflow.config.apps_config``, so a module-level config import
reachable from this package's ``__init__`` would close an import cycle.  Callers
own the configuration; this layer owns the arithmetic.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from deerflow.environment.requirements import EnvironmentStatus
from deerflow.environment.spec import OVERALL_DEGRADED, OVERALL_MISSING, OVERALL_OK


@dataclass(frozen=True)
class EnvironmentReport:
    """The whole answer: requirement reports + data-directory statuses."""

    enabled: bool
    requirement_status: EnvironmentStatus | None = None
    data_dir_statuses: list[Any] = field(default_factory=list)
    require_on_load: bool = False

    @property
    def requirement_overall(self) -> str:
        if self.requirement_status is None:
            return OVERALL_OK
        return self.requirement_status.overall

    def _required_data_dir_problems(self) -> list[Any]:
        return [status for status in self.data_dir_statuses if getattr(status, "required", False) and not getattr(status, "ok", True)]

    @property
    def overall(self) -> str:
        """``missing`` when something required is broken; ``degraded`` otherwise.

        Required items — requirement specs and data directories alike — decide
        ``missing``.  Only requirements can produce ``degraded``, from an
        ``unknown`` answer or an unmet *optional* declaration.

        A missing **optional directory** deliberately does not degrade the report:
        the derived retrieval index and the legacy threads root are created on
        demand (or never), so flagging their absence would put every healthy
        machine in the ``degraded`` state — and a signal that is always on is not
        a signal.  Optional *requirements* are different: an operator declared a
        fact about the machine, and an unmet declaration is worth surfacing.
        """
        if self.requirement_overall == OVERALL_MISSING or self._required_data_dir_problems():
            return OVERALL_MISSING
        if self.requirement_overall != OVERALL_OK:
            return OVERALL_DEGRADED
        return OVERALL_OK

    @property
    def blocking_problems(self) -> list[str]:
        """Human-readable lines for everything a startup gate would refuse on."""
        problems: list[str] = []
        if self.requirement_status is not None:
            for result in self.requirement_status.failures:
                problems.append(f"{result.spec.kind} {result.spec.name!r}: {result.outcome} ({result.detail})")
        for status in self._required_data_dir_problems():
            problems.append(f"data directory {status.name!r} ({status.path}): {status.problem}")
        return problems

    def to_dict(self) -> dict[str, object]:
        requirement_payload = self.requirement_status.to_dict() if self.requirement_status is not None else None
        return {
            "enabled": self.enabled,
            "overall": self.overall,
            "require_on_load": self.require_on_load,
            "requirements": requirement_payload,
            "data_dirs": [status.to_dict() for status in self.data_dir_statuses],
            "blocking_problems": self.blocking_problems,
        }


def build_environment_report(
    *,
    enabled: bool = True,
    requirement_status: EnvironmentStatus | None = None,
    data_dir_statuses: list[Any] | None = None,
    require_on_load: bool = False,
) -> EnvironmentReport:
    """Combine the requirement and data-directory answers (pure)."""
    return EnvironmentReport(
        enabled=enabled,
        requirement_status=requirement_status,
        data_dir_statuses=list(data_dir_statuses or []),
        require_on_load=require_on_load,
    )


__all__ = ["EnvironmentReport", "build_environment_report"]
