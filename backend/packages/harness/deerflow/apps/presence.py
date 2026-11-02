"""Human-presence detection and access decisions for local applications (N10b).

Dev plan §17 asks for human/machine sharing of local professional software
(exclusive/shared mode, preemption rules, visibility, conflict avoidance) and
§21 repeats it for the shared workspace.  N4 already models the *cardinality*
half of sharing (``AppDefinition.exclusive`` reattaches to the live instance
instead of starting a second one) and N8 arbitrates declared quotas; what was
missing is the answer to "is a person using this application right now, and if
so, who wins?".

This module is the **pure** half of that answer:

- :class:`PresenceReport` — what a probe observed.  It never guesses: an
  unanswerable probe stays :data:`PRESENCE_UNKNOWN`, because "we could not
  tell" and "nobody is using it" must not collapse into the same value; the
  former is safe to proceed on, the latter is the thing preemption is about.
- :func:`decide_access` — the whole decision table as a pure function over the
  observed presence and the declared policy, in the spirit of
  ``deerflow.scheduler.triggers.is_trigger_due`` (N7) and
  ``deerflow.workflow.preview.make_preview`` (N10).

The I/O half (running a probe, waiting for a human to let go, marking a
takeover) lives in :mod:`deerflow.apps.session` — the single choke point every
application operation already passes through.  Keeping the decision pure is
what makes the "who wins" rule auditable instead of scattered across call
sites.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# ── Presence states ───────────────────────────────────────────────────────────

#: Nobody is using the application: free to take.
PRESENCE_IDLE = "idle"
#: The application reports work in flight.  The probe cannot say *who* started
#: it, so at acquisition time an in-flight job we did not start means someone
#: else is at the controls — treated exactly like :data:`PRESENCE_HUMAN`.
PRESENCE_BUSY = "busy"
#: A person is using the application.
PRESENCE_HUMAN = "human"
#: We cannot tell (no probe declared, the probe failed, or its output did not
#: parse).  Deliberately **not** blocking — see :func:`decide_access`.
PRESENCE_UNKNOWN = "unknown"

PRESENCE_STATES: frozenset[str] = frozenset({PRESENCE_IDLE, PRESENCE_BUSY, PRESENCE_HUMAN, PRESENCE_UNKNOWN})

#: States that mean "occupied by someone else" for an acquisition decision.
OCCUPIED_STATES: frozenset[str] = frozenset({PRESENCE_BUSY, PRESENCE_HUMAN})

# ── Access outcomes ───────────────────────────────────────────────────────────

#: Take the application (it is free, unknown, or a declared preemption).
ACCESS_PROCEED = "proceed"
#: Wait for the human to release the application, then re-decide.
ACCESS_WAIT = "wait"
#: Do not touch the application.
ACCESS_REFUSE = "refuse"
#: Take the application over from a person who is using it.
ACCESS_PREEMPT = "preempt"

ACCESS_OUTCOMES: frozenset[str] = frozenset({ACCESS_PROCEED, ACCESS_WAIT, ACCESS_REFUSE, ACCESS_PREEMPT})

# ── Conflict policies ─────────────────────────────────────────────────────────

#: Fail the operation when a person holds the application (default).
HUMAN_CONFLICT_FAIL = "fail"
#: Queue until the person releases it (bounded by ``acquire_timeout_seconds``).
HUMAN_CONFLICT_WAIT = "wait"
#: Take it over — only honoured when the definition declares ``allow_preempt``.
HUMAN_CONFLICT_PREEMPT = "preempt"

HUMAN_CONFLICT_POLICIES: frozenset[str] = frozenset({HUMAN_CONFLICT_FAIL, HUMAN_CONFLICT_WAIT, HUMAN_CONFLICT_PREEMPT})

#: Who holds an application instance (the ``holder`` exposed on a session).
HOLDER_MACHINE = "machine"
HOLDER_HUMAN = "human"
#: Acquired while presence could not be determined — honestly neither.
HOLDER_UNKNOWN = "unknown"

HOLDERS: frozenset[str] = frozenset({HOLDER_MACHINE, HOLDER_HUMAN, HOLDER_UNKNOWN})

#: ``source`` values on a report, so a reader can tell a live probe from a
#: cached answer or from the absence of any probe at all.
SOURCE_DRIVER = "driver"
SOURCE_ENGINE = "engine"
#: The answer was reused from a recent probe rather than taken now.
SOURCE_CACHE = "cache"
SOURCE_NONE = "none"


def normalize_presence_state(value: Any) -> str:
    """Coerce *value* to a known presence state, else :data:`PRESENCE_UNKNOWN`.

    Probe output is external input (a mismatched app version can print
    anything), so unrecognised values degrade to *unknown* instead of raising:
    a broken probe must not be able to fail a run, and it must never be able to
    claim the application is free.
    """
    if isinstance(value, str):
        token = value.strip().lower()
        if token in PRESENCE_STATES:
            return token
    return PRESENCE_UNKNOWN


def parse_presence_output(stdout: str) -> str:
    """Read a presence state from a probe command's stdout (N10b).

    The declared contract is one state token as the first word of the first
    non-empty line; anything else is :data:`PRESENCE_UNKNOWN`.  Being strict
    here is what stops a stray banner or a version string from being read as
    "the application is free".
    """
    for line in (stdout or "").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        return normalize_presence_state(stripped.split()[0])
    return PRESENCE_UNKNOWN


# ── Report ────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class PresenceReport:
    """What a presence probe observed about one application.

    ``state`` is validated on construction (a mis-typed state is a programmer
    error, not user input — probe output goes through
    :func:`normalize_presence_state` first).  ``detail`` carries the raw
    explanation for a human reader; ``source`` records where the answer came
    from so a cache hit cannot be mistaken for a live probe.
    """

    state: str = PRESENCE_UNKNOWN
    detail: str = ""
    source: str = SOURCE_NONE
    observed_at: float = 0.0

    def __post_init__(self) -> None:
        if self.state not in PRESENCE_STATES:
            raise ValueError(f"unknown presence state {self.state!r}; expected one of {sorted(PRESENCE_STATES)}")

    @classmethod
    def unknown(cls, *, detail: str = "", source: str = SOURCE_NONE, observed_at: float = 0.0) -> PresenceReport:
        """Build the *honest* "we could not tell" report."""
        return cls(state=PRESENCE_UNKNOWN, detail=detail, source=source, observed_at=observed_at)

    @property
    def is_occupied(self) -> bool:
        """Whether someone else appears to hold the application."""
        return self.state in OCCUPIED_STATES

    def to_dict(self) -> dict[str, Any]:
        """JSON-safe projection for the ports / API / tools."""
        return {"state": self.state, "detail": self.detail, "source": self.source, "observed_at": self.observed_at}


# ── Decision ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class AccessDecision:
    """The outcome of applying a conflict policy to an observed presence."""

    outcome: str
    reason: str
    presence: PresenceReport
    #: ``"human"`` when the decision takes the application over from a person.
    taken_over_from: str | None = None

    def __post_init__(self) -> None:
        if self.outcome not in ACCESS_OUTCOMES:
            raise ValueError(f"unknown access outcome {self.outcome!r}; expected one of {sorted(ACCESS_OUTCOMES)}")

    @property
    def allowed(self) -> bool:
        """Whether the caller may touch the application right now."""
        return self.outcome in (ACCESS_PROCEED, ACCESS_PREEMPT)

    @property
    def presence_unknown(self) -> bool:
        """Whether this decision was made without knowing who holds the app."""
        return self.presence.state == PRESENCE_UNKNOWN


def decide_access(
    report: PresenceReport,
    *,
    policy: str = HUMAN_CONFLICT_FAIL,
    allow_preempt: bool = False,
) -> AccessDecision:
    """Decide whether the engine may take an application (N10b, pure).

    Rules (the complete table):

    ==================  ============  ==============  ===============
    observed            fail          wait            preempt
    ==================  ============  ==============  ===============
    ``idle``            proceed       proceed         proceed
    ``unknown``         proceed       proceed         proceed
    ``busy``/``human``  refuse        wait            preempt*
    ==================  ============  ==============  ===============

    ``*`` only when *allow_preempt* is true; otherwise the policy **falls back
    to refuse**.  A declared ``preempt`` policy on an application that has not
    opted in must never silently take the software away from a person.

    ``unknown`` proceeds on purpose: the probe is best-effort (most GUI
    applications cannot report presence at all), so failing closed on ignorance
    would make every unprobeable application unusable — that is not safety, it
    is a lockout.  The decision still records that it was made blind, and
    callers surface it.
    """
    state = report.state

    if state == PRESENCE_IDLE or state == PRESENCE_UNKNOWN:
        reason = "application is free" if state == PRESENCE_IDLE else "presence could not be determined (not blocking)"
        return AccessDecision(outcome=ACCESS_PROCEED, reason=reason, presence=report)

    if state in OCCUPIED_STATES:
        who = "a person is using it" if state == PRESENCE_HUMAN else "the application reports work in flight"
        if policy == HUMAN_CONFLICT_WAIT:
            return AccessDecision(outcome=ACCESS_WAIT, reason=f"{who}; waiting for it to be released", presence=report)
        if policy == HUMAN_CONFLICT_PREEMPT:
            if allow_preempt:
                return AccessDecision(outcome=ACCESS_PREEMPT, reason=f"{who}; taking it over (allow_preempt is declared)", presence=report, taken_over_from=HOLDER_HUMAN)
            return AccessDecision(
                outcome=ACCESS_REFUSE,
                reason=f"{who}; policy is 'preempt' but the application does not declare allow_preempt",
                presence=report,
            )
        # fail (the default) and any unrecognised policy refuse: an unknown
        # policy must not be read as consent to take over.
        return AccessDecision(outcome=ACCESS_REFUSE, reason=f"{who}; refusing to take it over", presence=report)

    # Unreachable while PRESENCE_STATES is total; refusing is the safe default
    # if a future state is added without updating this table.
    return AccessDecision(outcome=ACCESS_REFUSE, reason=f"unrecognised presence state {state!r}", presence=report)


#: Who a freshly acquired instance belongs to, given the decision and report.
def holder_for(decision: AccessDecision) -> str:
    """Derive the session ``holder`` recorded at acquisition time.

    ``machine`` when the engine took a free application, ``human`` when it
    attached to (or preempted) one a person was using, and ``unknown`` when it
    took an application whose presence could not be determined.  This is what
    the engine *knew when it acquired*, not a live claim — live state is served
    by the presence probe.
    """
    if decision.presence.state == PRESENCE_UNKNOWN:
        return HOLDER_UNKNOWN
    if decision.presence.is_occupied:
        return HOLDER_HUMAN
    return HOLDER_MACHINE


__all__ = [
    "PRESENCE_IDLE",
    "PRESENCE_BUSY",
    "PRESENCE_HUMAN",
    "PRESENCE_UNKNOWN",
    "PRESENCE_STATES",
    "OCCUPIED_STATES",
    "ACCESS_PROCEED",
    "ACCESS_WAIT",
    "ACCESS_REFUSE",
    "ACCESS_PREEMPT",
    "ACCESS_OUTCOMES",
    "HUMAN_CONFLICT_FAIL",
    "HUMAN_CONFLICT_WAIT",
    "HUMAN_CONFLICT_PREEMPT",
    "HUMAN_CONFLICT_POLICIES",
    "HOLDER_MACHINE",
    "HOLDER_HUMAN",
    "HOLDER_UNKNOWN",
    "HOLDERS",
    "SOURCE_DRIVER",
    "SOURCE_ENGINE",
    "SOURCE_CACHE",
    "SOURCE_NONE",
    "normalize_presence_state",
    "parse_presence_output",
    "PresenceReport",
    "AccessDecision",
    "decide_access",
    "holder_for",
]
