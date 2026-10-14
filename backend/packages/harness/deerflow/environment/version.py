"""Version parsing and constraint matching for environment probes (N11).

Dev plan §22 asks for software/plugin/runtime/path probing that is *bound to
capability groups and validated on load*.  "Validated" means comparing a
detected version against a declared expectation, and that comparison is the one
part of probing that is easy to get subtly, silently wrong — a lexicographic
comparison says ``"4.10" < "4.9"``, and a lenient parser turns ``"unknown"``
into ``"satisfied"``.

So this module is deliberately small, dependency-free, and **pessimistic**:

- :func:`parse_version` only accepts text that *starts* with a version, after an
  optional ``v``.  Anything else is ``None``.
- :func:`extract_version` scans a line for the first version-like token, which is
  what a probe command's output needs (``"Blender 4.2.1 LTS"`` → ``4.2.1``).
- :func:`version_satisfies` returns ``True`` / ``False`` / **``None``** — and
  ``None`` means *we could not tell*, never "fine".  An unparsable observation or
  an unparsable constraint both answer ``None``, and the caller maps that to the
  ``unknown`` probe outcome rather than to a silent pass.

No ``packaging`` dependency: the repo does not ship one on the core path, and the
grammar actually used by local-software version commands is a small subset.
"""

from __future__ import annotations

import re

#: A version core: one or more dot-separated numeric components.
_VERSION_TEXT_RE = re.compile(r"v?\d+(?:\.\d+)*")

#: One constraint clause: optional operator, then a version core or ``*``.
_CLAUSE_RE = re.compile(r"^(?P<op>>=|<=|==|!=|>=?|<=?|=|\^|~)?(?P<version>v?\d+(?:\.\d+)*|\*)$")

#: Operators whose upper bound is exclusive and derived from the lower bound.
_CARET = "^"
_TILDE = "~"


def parse_version(text: object) -> tuple[int, ...] | None:
    """Parse *text* into a numeric component tuple, or ``None``.

    Accepts a leading/trailing-whitespace-padded string that **begins** with an
    optional ``v`` followed by dot-separated digits (``"v4.2.1"`` → ``(4, 2, 1)``).
    Trailing prose is tolerated (``"4.2.1 LTS"`` → ``(4, 2, 1)``) because version
    commands routinely append build metadata; leading prose is **not**, because
    ``"not installed"`` must not parse as a version.
    """
    if isinstance(text, (tuple, list)):
        parts: list[int] = []
        for item in text:
            if isinstance(item, bool) or not isinstance(item, int) or item < 0:
                return None
            parts.append(item)
        return tuple(parts) or None
    if not isinstance(text, str):
        return None
    stripped = text.strip()
    match = _VERSION_TEXT_RE.match(stripped)
    if match is None:
        return None
    core = match.group(0).lstrip("vV")
    if not core:
        return None
    return tuple(int(part) for part in core.split("."))


def extract_version(text: object) -> str | None:
    """Return the first version-like token in *text*, or ``None``.

    Used on probe output: a version command may print a banner, a path, or a
    build line before (or instead of) a version.  The first version-like token is
    the conventional answer; no token at all means we learned nothing, which the
    caller reports as ``unknown``.
    """
    if not isinstance(text, str):
        return None
    match = _VERSION_TEXT_RE.search(text)
    return match.group(0) if match is not None else None


def compare_versions(left: tuple[int, ...], right: tuple[int, ...]) -> int:
    """Compare two component tuples, padding the shorter one with zeros.

    ``(4, 2)`` and ``(4, 2, 0)`` compare equal — a version command that omits
    trailing zeros is not a different version.
    """
    width = max(len(left), len(right))
    padded_left = left + (0,) * (width - len(left))
    padded_right = right + (0,) * (width - len(right))
    if padded_left == padded_right:
        return 0
    return 1 if padded_left > padded_right else -1


def _caret_upper(parts: tuple[int, ...]) -> tuple[int, ...]:
    """Upper bound (exclusive) for npm-style ``^`` semantics.

    ``^4.2.1`` → ``<5``; ``^0.2.1`` → ``<0.3``; ``^0.0.3`` → ``<0.0.4``.  The
    bound is derived from the leftmost non-zero component, so a ``0.x`` version
    cannot be silently widened to ``<1``.
    """
    if parts and parts[0] != 0:
        return (parts[0] + 1,)
    if len(parts) > 1 and parts[1] != 0:
        return (0, parts[1] + 1)
    if len(parts) > 2:
        return (0, 0, parts[2] + 1)
    return (0, 0, 1)


def _tilde_upper(parts: tuple[int, ...]) -> tuple[int, ...]:
    """Upper bound (exclusive) for ``~`` semantics: pin the minor component."""
    if len(parts) >= 2:
        return (parts[0], parts[1] + 1)
    if not parts:
        return (1,)
    return (parts[0] + 1,)


def _satisfies_clause(observed: tuple[int, ...], clause: str) -> bool | None:
    """Evaluate one clause.  ``None`` means the clause could not be understood."""
    match = _CLAUSE_RE.match(clause.strip())
    if match is None:
        return None

    operator = match.group("op") or "=="
    raw_version = match.group("version")

    if raw_version == "*":
        # A wildcard still requires a *known* observed version: "any version" is
        # only answerable when we actually detected one.
        return True

    bound = parse_version(raw_version)
    if bound is None:
        return None

    if operator in (_CARET, _TILDE):
        upper = _caret_upper(bound) if operator == _CARET else _tilde_upper(bound)
        # [bound, upper)
        return compare_versions(observed, bound) >= 0 and compare_versions(observed, upper) < 0

    if operator == ">=":
        return compare_versions(observed, bound) >= 0
    if operator == ">":
        return compare_versions(observed, bound) > 0
    if operator == "<=":
        return compare_versions(observed, bound) <= 0
    if operator == "<":
        return compare_versions(observed, bound) < 0
    if operator == "!=":
        return compare_versions(observed, bound) != 0
    # "==" and "="
    return compare_versions(observed, bound) == 0


def version_satisfies(observed: object, constraint: object) -> bool | None:
    """Whether *observed* satisfies *constraint* (``None`` = unknown).

    *constraint* is a comma-separated conjunction of clauses
    (``">=4.0,<5"``); every clause must hold.  An empty/absent constraint means
    "any version", which still requires a parsable observation.

    A bare version (``"4.0"``) or ``=`` is an **exact** match after zero-padding,
    deliberately *not* npm's implicit caret (``"4.0"`` → ``>=4.0.0 <5.0.0``):
    silently widening an operator's literal version into a range is the kind of
    guess a validation layer must not make.  Use ``^``/``~`` to ask for a range.

    Returns ``None`` — never ``False`` and never ``True`` — when the observed
    version or any clause cannot be understood.  That direction is the whole
    point: a typo in a constraint must surface as *unknown* in the report, not as
    a silent pass or a false accusation.
    """
    observed_parts = parse_version(observed)
    if observed_parts is None:
        return None
    if constraint is None:
        return True
    if not isinstance(constraint, str):
        return None
    stripped = constraint.strip()
    if not stripped:
        return True

    for clause in stripped.split(","):
        result = _satisfies_clause(observed_parts, clause)
        if result is None:
            return None
        if not result:
            return False
    return True


__all__ = [
    "compare_versions",
    "extract_version",
    "parse_version",
    "version_satisfies",
]
