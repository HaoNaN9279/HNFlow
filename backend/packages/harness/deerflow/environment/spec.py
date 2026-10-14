"""Requirement declarations and probe outcomes for environment checks (N11).

Dev plan §22 asks the engine to probe *software version, plugins, language
runtimes and paths*, bound to capability groups and validated on load.  This
module owns the **declared** half: what an operator (or a skill package) says has
to exist, and the vocabulary the result side uses to answer.

Two decisions shape everything else here:

- **Requirements are data, not code.**  A :class:`RequirementSpec` is a small,
  ``extra="forbid"`` pydantic model so a typo in ``config.yaml`` or in a skill's
  frontmatter fails loudly at load rather than being ignored at run time.
- **The answer is three-valued, plus "we could not tell".**  ``ok`` /
  ``missing`` / ``mismatch`` / ``unknown`` — because collapsing ``unknown`` into
  ``missing`` would make every application without a version command permanently
  "uninstalled", and collapsing it into ``ok`` would make the check decorative.

No I/O lives here (see :mod:`deerflow.environment.probe`) and no decisions either
(see :mod:`deerflow.environment.evaluate`): this module is importable from a test
without touching the filesystem.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

# ── Probe kinds ───────────────────────────────────────────────────────────────


class ProbeKind(StrEnum):
    """What kind of thing a requirement is about.

    The kinds are deliberately few and each one answers a question a local
    professional-software workflow actually asks:

    - ``executable``: is this command on ``PATH`` (or at this absolute path)?
    - ``version``: run a command, read the version it prints, compare it.
    - ``path``: does this filesystem path exist (relative to the process cwd)?
    - ``runtime``: a language runtime — ``executable`` + ``version`` combined,
      reported separately because "python 3.12 is missing" is a different class
      of problem from "Blender is missing".
    - ``plugin``: an application plugin/extension exists — the same existence
      check as ``path``, but a relative name resolves against the *application's*
      ``working_dir``, which is the one real semantic difference between them.
    """

    EXECUTABLE = "executable"
    VERSION = "version"
    PATH = "path"
    RUNTIME = "runtime"
    PLUGIN = "plugin"


#: Kinds that execute a command (and therefore may carry ``command``/``expect``).
COMMAND_KINDS: frozenset[str] = frozenset({ProbeKind.VERSION, ProbeKind.RUNTIME})

#: Kinds that are pure existence checks.
EXISTENCE_KINDS: frozenset[str] = frozenset({ProbeKind.EXECUTABLE, ProbeKind.PATH, ProbeKind.PLUGIN})

# ── Outcomes ──────────────────────────────────────────────────────────────────

#: The requirement is satisfied.
PROBE_OK = "ok"
#: Something that should exist does not.
PROBE_MISSING = "missing"
#: Something exists but does not satisfy the declared expectation.
PROBE_MISMATCH = "mismatch"
#: We could not tell (no probe declared/failed/timed out, or output unparsable).
PROBE_UNKNOWN = "unknown"

PROBE_OUTCOMES: frozenset[str] = frozenset({PROBE_OK, PROBE_MISSING, PROBE_MISMATCH, PROBE_UNKNOWN})

#: Failures that mean "this machine is not ready", for a required spec.
FAILED_OUTCOMES: frozenset[str] = frozenset({PROBE_MISSING, PROBE_MISMATCH})

#: Overall states for a group of results.
OVERALL_OK = "ok"
#: Nothing required is broken, but something optional is, or something is unknown.
OVERALL_DEGRADED = "degraded"
#: At least one *required* spec is missing or mismatched.
OVERALL_MISSING = "missing"

OVERALL_STATES: frozenset[str] = frozenset({OVERALL_OK, OVERALL_DEGRADED, OVERALL_MISSING})

#: Where a report's results came from (so a reader can tell live from cached).
SOURCE_LIVE = "live"
SOURCE_CACHE = "cache"


class RequirementSpec(BaseModel):
    """One declared environment requirement.

    ``command`` is an **argv list**, never a shell string: inventing quoting,
    ``PATHEXT`` and backslash rules here is exactly the trap N10b avoided for
    ``presence_command``, and an argv list is unambiguous on both platforms.
    When omitted for a command kind, ``[name, "--version"]`` is used.
    """

    model_config = ConfigDict(extra="forbid")

    kind: ProbeKind = Field(..., description="What the requirement is about.")
    name: str = Field(..., description="Executable name, path (may contain $VARS/~), runtime name, or plugin name/path.")
    command: list[str] | None = Field(
        default=None,
        description="argv used to ask for a version (command kinds only). Defaults to [name, '--version'].",
    )
    expect: str | None = Field(
        default=None,
        description="Version constraint (e.g. '>=4.0,<5', '^4.2', '~1.3') for version/runtime kinds. Omitted = any version.",
    )
    optional: bool = Field(
        default=False,
        description="When true a failure is reported but does not make the environment 'missing'.",
    )

    @field_validator("name")
    @classmethod
    def _name_not_blank(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("name must be a non-empty string")
        return stripped

    @field_validator("command")
    @classmethod
    def _command_tokens(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        if not value:
            raise ValueError("command must not be an empty list")
        tokens: list[str] = []
        for token in value:
            if not isinstance(token, str):
                raise ValueError(f"command tokens must be strings; got {token!r}")
            if not token.strip():
                raise ValueError("command tokens must not be empty")
            tokens.append(token)
        return tokens

    @field_validator("expect")
    @classmethod
    def _expect_strip(cls, value: str | None) -> str | None:
        """Normalize blank to ``None`` = "any version" (not "empty constraint")."""
        if value is None:
            return None
        stripped = value.strip()
        return stripped or None

    @model_validator(mode="after")
    def _kind_field_rules(self) -> RequirementSpec:
        """Reject fields that cannot mean anything for the declared kind.

        A config that says ``kind: path`` with a ``command`` is a mistake about
        intent, not a harmless extra: silently ignoring it would leave the
        operator waiting for a probe that never runs.
        """
        if self.command is not None and self.kind not in COMMAND_KINDS:
            raise ValueError(f"command is only meaningful for {sorted(COMMAND_KINDS)}; got kind={self.kind!r}")
        if self.expect is not None and self.kind not in COMMAND_KINDS:
            raise ValueError(f"expect is only meaningful for {sorted(COMMAND_KINDS)}; got kind={self.kind!r}")
        return self

    def resolved_command(self) -> list[str] | None:
        """The argv to execute, or ``None`` for a pure existence check."""
        if self.kind not in COMMAND_KINDS:
            return None
        return list(self.command) if self.command else [self.name, "--version"]

    def describe(self) -> str:
        """One-line human summary used in logs and the report."""
        suffix = f" {self.expect}" if self.expect else ""
        optional = " (optional)" if self.optional else ""
        return f"{self.kind}:{self.name}{suffix}{optional}"


@dataclass(frozen=True)
class ProbeResult:
    """The outcome of evaluating one spec against one observation.

    ``observed`` carries whatever we actually saw — the resolved executable path,
    the detected version, the checked path — so a report can show evidence
    instead of only a verdict.  ``source`` records whether this came from a live
    probe or a recent cache entry, the same distinction a presence report makes.
    """

    spec: RequirementSpec
    outcome: str
    observed: str = ""
    detail: str = ""
    source: str = SOURCE_LIVE

    def __post_init__(self) -> None:
        if self.outcome not in PROBE_OUTCOMES:
            raise ValueError(f"unknown probe outcome {self.outcome!r}; expected one of {sorted(PROBE_OUTCOMES)}")

    @property
    def failed(self) -> bool:
        """Whether this is a definite failure (``unknown`` is not)."""
        return self.outcome in FAILED_OUTCOMES

    def to_dict(self) -> dict[str, object]:
        """JSON-safe projection for the API/CLI report."""
        return {
            "kind": str(self.spec.kind),
            "name": self.spec.name,
            "expect": self.spec.expect,
            "optional": self.spec.optional,
            "outcome": self.outcome,
            "observed": self.observed,
            "detail": self.detail,
            "source": self.source,
        }


@dataclass(frozen=True)
class RequirementReport:
    """All probe results for one source (an application, or a skill).

    ``source`` is a stable locator (``"app:blender"`` / ``"skill:cad-export"``);
    ``label`` is what a human reads.  ``overall`` and ``failures`` are derived,
    so no caller has to re-derive the required/optional arithmetic.
    """

    source: str
    label: str = ""
    results: tuple[ProbeResult, ...] = field(default_factory=tuple)

    @property
    def overall(self) -> str:
        """``missing`` when a required spec failed, else ``degraded``/``ok``.

        An ``unknown`` result is *degraded* rather than either extreme: we did
        not learn that the environment is fine, and we certainly did not learn
        that it is broken.
        """
        if self.failures:
            return OVERALL_MISSING
        if any(result.outcome == PROBE_UNKNOWN for result in self.results):
            return OVERALL_DEGRADED
        if any(result.failed for result in self.results):  # optional failures only
            return OVERALL_DEGRADED
        return OVERALL_OK

    @property
    def failures(self) -> tuple[ProbeResult, ...]:
        """Required specs that definitively failed."""
        return tuple(result for result in self.results if result.failed and not result.spec.optional)

    @property
    def optional_failures(self) -> tuple[ProbeResult, ...]:
        """Optional specs that definitively failed."""
        return tuple(result for result in self.results if result.failed and result.spec.optional)

    @property
    def unknowns(self) -> tuple[ProbeResult, ...]:
        """Specs we could not answer at all."""
        return tuple(result for result in self.results if result.outcome == PROBE_UNKNOWN)

    def to_dict(self) -> dict[str, object]:
        return {
            "source": self.source,
            "label": self.label,
            "overall": self.overall,
            "results": [result.to_dict() for result in self.results],
        }


__all__ = [
    "ProbeKind",
    "COMMAND_KINDS",
    "EXISTENCE_KINDS",
    "PROBE_OK",
    "PROBE_MISSING",
    "PROBE_MISMATCH",
    "PROBE_UNKNOWN",
    "PROBE_OUTCOMES",
    "FAILED_OUTCOMES",
    "OVERALL_OK",
    "OVERALL_DEGRADED",
    "OVERALL_MISSING",
    "OVERALL_STATES",
    "SOURCE_LIVE",
    "SOURCE_CACHE",
    "RequirementSpec",
    "ProbeResult",
    "RequirementReport",
]
