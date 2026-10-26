"""Static specification-quality checks.

This is deliberately a linter, not a prover.  It catches the cheap failure
mode where a "specification" constrains nothing (``requires true`` / empty
body / Lean ``sorry``) so the human approval gate reviews something meaningful.
"""

from __future__ import annotations

import re

from deerflow.workflow.spec import SpecLanguage
from deerflow.workflow.verification import VerifierIssue

_TRIVIAL_REQUIRES = re.compile(r"\brequires\s+(true|\(\s*\)|\{\s*\})", re.IGNORECASE)
_TRIVIAL_ENSURES = re.compile(r"\bensures\s+(true|\(\s*\)|\{\s*\})", re.IGNORECASE)


def lint_spec_content(language: SpecLanguage, content: str) -> list[VerifierIssue]:
    """Return structured spec-quality issues (empty list means no findings)."""
    text = content.strip()
    issues: list[VerifierIssue] = []
    if not text:
        return [VerifierIssue(category="spec_quality", severity="error", message="specification is empty")]

    if language is SpecLanguage.DAFNY:
        if _TRIVIAL_REQUIRES.search(text):
            issues.append(VerifierIssue(category="vacuous", severity="error", message="precondition is `requires true` (constrains nothing)"))
        if _TRIVIAL_ENSURES.search(text):
            issues.append(VerifierIssue(category="vacuous", severity="error", message="postcondition is `ensures true` (constrains nothing)"))
        if not re.search(r"\b(requires|ensures|invariant|decreases)\b", text):
            issues.append(VerifierIssue(category="spec_quality", severity="warning", message="Dafny spec has no requires/ensures/invariant/decreases clause"))
        if re.search(r"\b(method|function)\b", text) and "decreases" not in text:
            issues.append(VerifierIssue(category="termination", severity="warning", message="recursive Dafny constructs usually need a decreases clause"))

    elif language is SpecLanguage.LEAN:
        if re.search(r"\bsorry\b", text):
            issues.append(VerifierIssue(category="incomplete_proof", severity="error", message="Lean proof contains `sorry`"))
        if not re.search(r"\b(theorem|lemma|example)\b", text):
            issues.append(VerifierIssue(category="spec_quality", severity="warning", message="Lean file declares no theorem/lemma"))

    elif language is SpecLanguage.TLA:
        for required in ("Init", "Next"):
            if not re.search(rf"\b{required}\b", text):
                issues.append(VerifierIssue(category="spec_quality", severity="error", message=f"TLA+ spec is missing `{required}`"))
        if not re.search(r"\b(Spec|INVARIANT|PROPERTY|THEOREM)\b", text):
            issues.append(VerifierIssue(category="spec_quality", severity="warning", message="TLA+ spec declares no Spec/INVARIANT/PROPERTY/THEOREM"))

    elif language is SpecLanguage.CEL:
        if not text:
            issues.append(VerifierIssue(category="vacuous", severity="error", message="CEL expression is empty"))

    return issues


__all__ = ["lint_spec_content"]
