"""Shared verifier execution helpers.

Verifier CLIs are commands, so they run through the sandbox exactly like
``tool:bash``.  A verifier never executes on the host outside that boundary.
"""

from __future__ import annotations

import hashlib
import re
import time
from typing import Any

from deerflow.sandbox import tools as sandbox_tools
from deerflow.workflow.spec import SpecLanguage
from deerflow.workflow.verification import VerificationResult, VerificationStatus, VerifierIssue

_VERIFY_ROOT = "/mnt/user-data/workspace/.hnflow-verify"
_EXIT_CODE = re.compile(r"Exit Code:\s*(\d+)")


def sandbox_for(runtime: Any) -> Any:
    if runtime is None:
        raise RuntimeError("verifier tool requires a runtime with a sandbox")
    return sandbox_tools.ensure_sandbox_initialized(runtime)


def _write_source(runtime: Any, filename: str, content: str) -> str:
    sandbox = sandbox_for(runtime)
    safe_name = re.sub(r"[^A-Za-z0-9_.-]", "_", filename) or "source.txt"
    path = f"{_VERIFY_ROOT}/{safe_name}"
    sandbox.write_file(path, content)
    return path


def _issue(category: str, message: str, *, file: str | None = None, line: int | None = None, column: int | None = None) -> VerifierIssue:
    location: dict[str, Any] = {}
    if file is not None:
        location["file"] = file
    if line is not None:
        location["line"] = line
    if column is not None:
        location["column"] = column
    return VerifierIssue(category=category, message=message, location=location)


def _hash(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def _is_unavailable(output: str) -> bool:
    lowered = output.lower()
    return any(
        marker in lowered
        for marker in (
            "command not found",
            "not recognized as an internal or external command",
            "no such file or directory",
            "cannot find the file",
        )
    )


def _is_timeout(output: str) -> bool:
    lowered = output.lower()
    return "timed out" in lowered or "timeout" in lowered and "exit code" not in lowered


def _exit_code(output: str) -> int:
    match = _EXIT_CODE.search(output)
    return int(match.group(1)) if match else 0


def run_verifier_command(
    runtime: Any,
    *,
    language: SpecLanguage,
    verifier: str,
    filename: str,
    content: str,
    command_template: str,
    timeout_seconds: float,
    parser: Any,
) -> VerificationResult:
    """Write the source into the sandbox, run a verifier CLI, and normalize.

    ``parser`` is a callable ``(output, source_path) -> VerificationResult``.
    Infrastructure failures (missing binary, timeout) become ``inconclusive``;
    a parseable proof failure becomes ``failed``.
    """
    started = time.monotonic()
    try:
        source_path = _write_source(runtime, filename, content)
        sandbox = sandbox_for(runtime)
        command = command_template.format(source=source_path)
        output = sandbox.execute_command(command, timeout=timeout_seconds)
    except Exception as exc:  # noqa: BLE001 - verifier infrastructure failure
        return VerificationResult(
            status=VerificationStatus.INCONCLUSIVE,
            language=language,
            verifier=verifier,
            reason=f"verifier_error: {type(exc).__name__}: {exc}",
            duration_ms=int((time.monotonic() - started) * 1000),
        )

    duration_ms = int((time.monotonic() - started) * 1000)
    if _is_timeout(output):
        return VerificationResult(
            status=VerificationStatus.INCONCLUSIVE,
            language=language,
            verifier=verifier,
            reason="timeout",
            duration_ms=duration_ms,
            output_hash=_hash(output),
            raw_output=output,
        )
    if _is_unavailable(output):
        return VerificationResult(
            status=VerificationStatus.INCONCLUSIVE,
            language=language,
            verifier=verifier,
            reason=f"verifier_unavailable: {verifier}",
            duration_ms=duration_ms,
            output_hash=_hash(output),
            raw_output=output,
        )

    result = parser(output, source_path)
    result.duration_ms = duration_ms
    result.output_hash = result.output_hash or _hash(output)
    result.raw_output = result.raw_output or output
    return result


def parse_dafny(output: str, source_path: str) -> VerificationResult:
    errors: list[VerifierIssue] = []
    for line in output.splitlines():
        if "Error:" in line or " error:" in line:
            errors.append(_issue("proof_failure", line.strip(), file=source_path))
    lowered = output.lower()
    verified = "0 errors" in lowered or "verified" in lowered
    failed = bool(errors) or "error" in lowered or _exit_code(output) != 0
    if failed:
        return VerificationResult(
            status=VerificationStatus.FAILED,
            language=SpecLanguage.DAFNY,
            verifier="dafny_verify",
            errors=errors or [_issue("proof_failure", "Dafny reported a verification failure", file=source_path)],
        )
    return VerificationResult(
        status=VerificationStatus.VERIFIED if verified else VerificationStatus.INCONCLUSIVE,
        language=SpecLanguage.DAFNY,
        verifier="dafny_verify",
        reason=None if verified else "dafny produced no recognizable verdict",
    )


def parse_tla(output: str, source_path: str) -> VerificationResult:
    lowered = output.lower()
    if "no error has been found" in lowered or "model checking completed" in lowered:
        return VerificationResult(
            status=VerificationStatus.VERIFIED,
            language=SpecLanguage.TLA,
            verifier="tla_model_check",
        )
    if "is violated" in lowered or "error:" in lowered:
        violated = None
        for line in output.splitlines():
            if "is violated" in line or "violated" in line.lower():
                violated = line.strip()
                break
        return VerificationResult(
            status=VerificationStatus.FAILED,
            language=SpecLanguage.TLA,
            verifier="tla_model_check",
            errors=[_issue("invariant", violated or "TLC reported an invariant violation", file=source_path)],
            counterexample={"violated_property": violated, "state_sequence": []},
        )
    return VerificationResult(
        status=VerificationStatus.INCONCLUSIVE,
        language=SpecLanguage.TLA,
        verifier="tla_model_check",
        reason="tlc produced no recognizable verdict",
    )


def parse_lean(output: str, source_path: str) -> VerificationResult:
    errors: list[VerifierIssue] = []
    for line in output.splitlines():
        if "error:" in line.lower() or "sorry" in line.lower():
            errors.append(_issue("proof_failure", line.strip(), file=source_path))
    if errors or _exit_code(output) != 0:
        return VerificationResult(
            status=VerificationStatus.FAILED,
            language=SpecLanguage.LEAN,
            verifier="lean_check",
            errors=errors or [_issue("proof_failure", "Lean reported a proof failure", file=source_path)],
        )
    return VerificationResult(
        status=VerificationStatus.VERIFIED,
        language=SpecLanguage.LEAN,
        verifier="lean_check",
    )


__all__ = [
    "parse_dafny",
    "parse_lean",
    "parse_tla",
    "run_verifier_command",
    "sandbox_for",
]
