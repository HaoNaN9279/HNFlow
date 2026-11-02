"""``verify:gate`` — execute a verifier and emit a three-valued decision."""

from __future__ import annotations

import time
from typing import Any

from deerflow.sandbox import tools as sandbox_tools
from deerflow.workflow.compiler import WorkflowRuntime
from deerflow.workflow.executors.tool import _build_tool_runtime, _call_tool
from deerflow.workflow.registry import WorkflowExecutionError
from deerflow.workflow.spec import SpecLanguage, SpecRef, parse_spec_ref
from deerflow.workflow.verification import (
    VERIFICATION_RESULT_KEY,
    VERIFY_EVIDENCE_PORT,
    VERIFY_FAILED_PORT,
    VERIFY_IMPLEMENTATION_PORT,
    VERIFY_INCONCLUSIVE_PORT,
    VERIFY_SPEC_PORT,
    VERIFY_STATUS_PORT,
    VERIFY_VERIFIED_PORT,
    VerificationResult,
    VerificationStatus,
    normalize_verifier_result,
    parse_verifier_selection,
    verification_summary,
)


def _resolve_spec(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> SpecRef:
    raw = inputs.get(VERIFY_SPEC_PORT) or params.get("spec_ref")
    if raw is None:
        raise WorkflowExecutionError("verify:gate: no spec reference (bind the 'spec' input or set params.spec_ref)")
    try:
        return parse_spec_ref(raw)
    except ValueError as exc:
        raise WorkflowExecutionError(f"verify:gate: {exc}") from exc


def _dict_param(params: dict[str, Any], key: str) -> dict[str, Any]:
    value = params.get(key)
    return value if isinstance(value, dict) else {}


def _implementation(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> str:
    value = inputs.get(VERIFY_IMPLEMENTATION_PORT)
    target = _dict_param(params, "target")
    source_mode = str(target.get("source") or ("inline" if value is not None else "file"))
    if source_mode == "inline":
        if isinstance(value, str):
            return value
        if isinstance(value, dict):
            for key in ("source", "content", "text"):
                if isinstance(value.get(key), str):
                    return value[key]
        raise WorkflowExecutionError("verify:gate: implementation input must carry inline source text (or use target.source='file')")
    path = target.get("path") or (value if isinstance(value, str) else None)
    if not isinstance(path, str) or not path:
        raise WorkflowExecutionError("verify:gate: target.source='file' requires target.path or a path string on the implementation input")
    try:
        sandbox = sandbox_tools.ensure_sandbox_initialized(runtime)  # type: ignore[arg-type]
        return sandbox.read_file(path)
    except Exception as exc:  # noqa: BLE001 - missing file is a workflow wiring error
        raise WorkflowExecutionError(f"verify:gate: cannot read implementation file {path!r}: {exc}") from exc


def _tool_arguments(verifier: str, *, spec_text: str, language: SpecLanguage, implementation: str, params: dict[str, Any]) -> dict[str, Any]:
    target = _dict_param(params, "target")
    filename = str(target.get("filename") or params.get("filename") or "source.txt")
    timeout_seconds = float(params.get("timeout_seconds", 120))
    if verifier == "spec_lint":
        return {"language": language.value, "content": spec_text}
    if verifier == "mock_verifier":
        return {
            "mode": str(params.get("mock_mode") or params.get("mode") or "verified"),
            "message": str(params.get("mock_message") or params.get("message") or ""),
            "category": str(params.get("mock_category") or params.get("category") or "proof_failure"),
        }
    if verifier == "cel_evaluate":
        return {"expression": implementation, "payload": _dict_param(params, "payload")}
    return {"source": implementation, "filename": filename, "timeout_seconds": timeout_seconds}


async def exec_verify_gate(runtime: WorkflowRuntime, params: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """Run one verifier through the ToolGateway and emit exactly one branch.

    The verifier itself is read-only and idempotent.  A missing spec, gateway,
    or verifier tool is a workflow configuration error (raise); a verifier
    timeout/crash/malformed result is ``inconclusive`` (route to a human), not
    ``failed``.
    """
    started = time.monotonic()
    node_id = str(params.get("node_id") or "verify:gate")
    spec_ref = _resolve_spec(runtime, params, inputs)
    context = runtime.context or {}
    repo = context.get("spec_repo")
    if repo is None:
        raise WorkflowExecutionError(f"node '{node_id}': verify:gate requires a 'spec_repo' in runtime context")
    user_id = str(context.get("user_id") or "")
    try:
        spec_row = await repo.resolve_ref(spec_ref, user_id=user_id)
    except Exception as exc:  # noqa: BLE001 - missing/unfrozen/hash mismatch is fail-loud
        raise WorkflowExecutionError(f"node '{node_id}': cannot resolve spec {spec_ref.spec_id}@{spec_ref.revision}: {exc}") from exc

    language = SpecLanguage(spec_row["language"])
    spec_text = str(spec_row["content"])
    implementation = _implementation(runtime, params, inputs)

    try:
        verifier_id, provider = parse_verifier_selection(params, language)
    except ValueError as exc:
        raise WorkflowExecutionError(f"node '{node_id}': {exc}") from exc

    gateway = context.get("tool_gateway")
    if gateway is None:
        raise WorkflowExecutionError(f"node '{node_id}': verify:gate requires a 'tool_gateway' in runtime context")
    resolved = gateway.resolve_with_provider(verifier_id, provider=provider)
    if resolved is None:
        scope = f" (provider={provider!r})" if provider else ""
        raise WorkflowExecutionError(f"node '{node_id}': verifier tool {verifier_id!r} could not be resolved{scope}; registered providers: {gateway.provider_names()}")
    tool, resolved_provider = resolved

    arguments = _tool_arguments(tool.name, spec_text=spec_text, language=language, implementation=implementation, params=params)
    try:
        raw = await _call_tool(tool, arguments, tool_runtime=_build_tool_runtime(runtime), tool_name=tool.name)
        result = normalize_verifier_result(raw, verifier_fallback=tool.name)
    except Exception as exc:  # noqa: BLE001 - a verifier crash is not proof of failure
        result = VerificationResult(
            status=VerificationStatus.INCONCLUSIVE,
            language=language,
            verifier=tool.name,
            reason=f"verifier_error: {type(exc).__name__}: {exc}",
            duration_ms=int((time.monotonic() - started) * 1000),
        )

    if result.language is None:
        result.language = language
    if result.duration_ms is None:
        result.duration_ms = int((time.monotonic() - started) * 1000)
    if result.verifier_version is None:
        result.verifier_version = None

    evidence = {
        "spec": spec_ref.to_dict(),
        "verifier": tool.name,
        "provider": resolved_provider,
        "verifier_version": result.verifier_version,
        "duration_ms": result.duration_ms,
        "output_hash": result.output_hash,
        "error_count": len(result.errors),
        "reason": result.reason,
    }
    outputs: dict[str, Any] = {
        VERIFY_STATUS_PORT: result.status.value,
        VERIFY_EVIDENCE_PORT: evidence,
        VERIFICATION_RESULT_KEY: verification_summary(node_id, spec_ref, result),
    }
    branch_status = {
        VerificationStatus.VERIFIED: VERIFY_VERIFIED_PORT,
        VerificationStatus.FAILED: VERIFY_FAILED_PORT,
        VerificationStatus.INCONCLUSIVE: VERIFY_INCONCLUSIVE_PORT,
    }
    selected = branch_status[result.status]
    for port in (VERIFY_VERIFIED_PORT, VERIFY_FAILED_PORT, VERIFY_INCONCLUSIVE_PORT):
        outputs[port] = result.bundled() if port == selected else None
    return outputs


__all__ = ["VERIFICATION_RESULT_KEY", "exec_verify_gate"]
