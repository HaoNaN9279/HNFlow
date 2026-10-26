"""Built-in verifier tools exposed through the workflow ToolGateway."""

from __future__ import annotations

import json
from typing import Annotated, Any

from langchain_core.tools import InjectedToolArg, StructuredTool
from pydantic import BaseModel, Field

from deerflow.workflow.spec import SpecLanguage
from deerflow.workflow.verification import VerificationResult, VerificationStatus
from deerflow.workflow.verifiers.common import (
    parse_dafny,
    parse_lean,
    parse_tla,
    run_verifier_command,
)
from deerflow.workflow.verifiers.spec_lint import lint_spec_content

_VERIFIER_METADATA = {"side_effect": False, "deterministic": True, "verification": True}


class _SpecLintInput(BaseModel):
    language: str = Field(description="Specification language: dafny / lean / tla / cel")
    content: str = Field(description="Specification text to lint")


async def _spec_lint(language: str, content: str) -> str:
    try:
        parsed = SpecLanguage(language)
    except ValueError:
        parsed = SpecLanguage.DAFNY
    issues = lint_spec_content(parsed, content)
    payload = VerificationResult(
        status=VerificationStatus.FAILED if any(issue.severity == "error" for issue in issues) else VerificationStatus.VERIFIED,
        language=parsed,
        verifier="spec_lint",
        errors=issues,
        reason=None if not issues else "specification lint findings",
    )
    return json.dumps(payload.model_dump(mode="json"), ensure_ascii=False)


def spec_lint_tool() -> StructuredTool:
    return StructuredTool.from_function(
        coroutine=_spec_lint,
        name="spec_lint",
        description="Static specification checks: vacuous clauses, missing invariants, Lean sorry, TLA Init/Next.",
        args_schema=_SpecLintInput,
        metadata=_VERIFIER_METADATA,
    )


class _MockVerifierInput(BaseModel):
    mode: str = Field(default="verified", description="verified / failed / inconclusive")
    message: str = Field(default="", description="Optional diagnostic message")
    category: str = Field(default="proof_failure", description="Failure category")


async def _mock_verifier(mode: str, message: str, category: str) -> str:
    try:
        status = VerificationStatus(str(mode).strip().lower())
    except ValueError:
        status = VerificationStatus.INCONCLUSIVE
    payload = VerificationResult(
        status=status,
        language=SpecLanguage.DAFNY,
        verifier="mock_verifier",
        verifier_version="1",
        errors=[] if status is VerificationStatus.VERIFIED else [{"category": category, "severity": "error", "message": message or status.value, "location": {}}],
        reason=None if status is VerificationStatus.VERIFIED else status.value,
        counterexample={"state_sequence": [{"pc": "impl"}], "violated_property": message} if status is VerificationStatus.FAILED else None,
    )
    return json.dumps(payload.model_dump(mode="json"), ensure_ascii=False)


def mock_verifier_tool() -> StructuredTool:
    return StructuredTool.from_function(
        coroutine=_mock_verifier,
        name="mock_verifier",
        description="Deterministic verifier double for tests and workflow authoring.",
        args_schema=_MockVerifierInput,
        metadata=_VERIFIER_METADATA,
    )


class _DafnyInput(BaseModel):
    source: str = Field(description="Dafny source text")
    filename: str = Field(default="impl.dfy")
    timeout_seconds: float = Field(default=120.0, ge=1.0)


async def _dafny_verify(source: str, filename: str, timeout_seconds: float, runtime: Annotated[Any, InjectedToolArg] = None) -> str:
    result = run_verifier_command(
        runtime,
        language=SpecLanguage.DAFNY,
        verifier="dafny_verify",
        filename=filename,
        content=source,
        command_template="dafny verify --show-snippets:false {source}",
        timeout_seconds=timeout_seconds,
        parser=parse_dafny,
    )
    return json.dumps(result.model_dump(mode="json"), ensure_ascii=False)


def dafny_verify_tool() -> StructuredTool:
    return StructuredTool.from_function(
        coroutine=_dafny_verify,
        name="dafny_verify",
        description="Verify a Dafny program with the Dafny CLI inside the sandbox.",
        args_schema=_DafnyInput,
        metadata=_VERIFIER_METADATA,
    )


class _TlaInput(BaseModel):
    source: str = Field(description="TLA+ module text")
    filename: str = Field(default="Spec.tla")
    timeout_seconds: float = Field(default=120.0, ge=1.0)


async def _tla_model_check(source: str, filename: str, timeout_seconds: float, runtime: Annotated[Any, InjectedToolArg] = None) -> str:
    result = run_verifier_command(
        runtime,
        language=SpecLanguage.TLA,
        verifier="tla_model_check",
        filename=filename,
        content=source,
        command_template="tlc {source}",
        timeout_seconds=timeout_seconds,
        parser=parse_tla,
    )
    return json.dumps(result.model_dump(mode="json"), ensure_ascii=False)


def tla_model_check_tool() -> StructuredTool:
    return StructuredTool.from_function(
        coroutine=_tla_model_check,
        name="tla_model_check",
        description="Run the TLA+ TLC model checker inside the sandbox.",
        args_schema=_TlaInput,
        metadata=_VERIFIER_METADATA,
    )


class _LeanInput(BaseModel):
    source: str = Field(description="Lean source text")
    filename: str = Field(default="Proof.lean")
    timeout_seconds: float = Field(default=120.0, ge=1.0)


async def _lean_check(source: str, filename: str, timeout_seconds: float, runtime: Annotated[Any, InjectedToolArg] = None) -> str:
    result = run_verifier_command(
        runtime,
        language=SpecLanguage.LEAN,
        verifier="lean_check",
        filename=filename,
        content=source,
        command_template="lean {source}",
        timeout_seconds=timeout_seconds,
        parser=parse_lean,
    )
    return json.dumps(result.model_dump(mode="json"), ensure_ascii=False)


def lean_check_tool() -> StructuredTool:
    return StructuredTool.from_function(
        coroutine=_lean_check,
        name="lean_check",
        description="Check a Lean proof file inside the sandbox.",
        args_schema=_LeanInput,
        metadata=_VERIFIER_METADATA,
    )


class _CelInput(BaseModel):
    expression: str = Field(description="CEL expression")
    payload: dict[str, Any] = Field(default_factory=dict, description="Input variables")


async def _cel_evaluate(expression: str, payload: dict[str, Any] | None = None) -> str:
    # CEL evaluation is a later phase.  Returning an explicit inconclusive
    # result is honest and keeps the gate's three-valued contract intact.
    _ = payload
    result = VerificationResult(
        status=VerificationStatus.INCONCLUSIVE,
        language=SpecLanguage.CEL,
        verifier="cel_evaluate",
        reason="cel evaluator is not installed; configure a CEL MCP provider or enable the optional evaluator",
    )
    _ = expression
    return json.dumps(result.model_dump(mode="json"), ensure_ascii=False)


def cel_evaluate_tool() -> StructuredTool:
    return StructuredTool.from_function(
        coroutine=_cel_evaluate,
        name="cel_evaluate",
        description="Evaluate a CEL runtime contract (optional phase-4 verifier).",
        args_schema=_CelInput,
        metadata=_VERIFIER_METADATA,
    )


def verifier_tools() -> dict[str, Any]:
    """All built-in verifier tools keyed by their model-visible name."""
    tools = (
        spec_lint_tool(),
        mock_verifier_tool(),
        dafny_verify_tool(),
        tla_model_check_tool(),
        lean_check_tool(),
        cel_evaluate_tool(),
    )
    return {tool.name: tool for tool in tools}


__all__ = [
    "cel_evaluate_tool",
    "dafny_verify_tool",
    "lean_check_tool",
    "mock_verifier_tool",
    "spec_lint_tool",
    "tla_model_check_tool",
    "verifier_tools",
]
