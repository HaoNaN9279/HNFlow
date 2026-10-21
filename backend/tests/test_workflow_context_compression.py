"""Automatic context-compression budget tests."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from deerflow.workflow.context_compression import (
    ContextCompression,
    ContextCompressionError,
    estimate_tokens,
    resolve_context_compression,
)


def _model(name: str = "m", *, window: int | None = 32768, max_tokens: int | None = 4096) -> SimpleNamespace:
    return SimpleNamespace(name=name, context_window=window, max_tokens=max_tokens)


def test_budget_is_derived_from_the_model_window() -> None:
    compression = resolve_context_compression("m", [_model()])

    assert compression.model_name == "m"
    assert compression.context_window == 32768
    assert compression.input_budget == 32768 - 4096
    assert 0 < compression.keep_tokens < compression.trigger_tokens < compression.input_budget


def test_missing_context_window_fails_loud() -> None:
    with pytest.raises(ContextCompressionError, match="context_window"):
        resolve_context_compression("m", [_model(window=None)])


def test_missing_model_fails_loud() -> None:
    with pytest.raises(ContextCompressionError, match="not configured"):
        resolve_context_compression("missing", [_model()])


def test_token_estimate_is_cjk_aware() -> None:
    assert estimate_tokens("") == 0
    assert estimate_tokens("abcd") == 1
    assert estimate_tokens("中文") == 1


def test_build_middleware_uses_skill_prompt(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    def fake_model(**kwargs: Any) -> object:
        captured["model_kwargs"] = kwargs
        return object()

    class FakeMiddleware:
        def __init__(self, **kwargs: Any) -> None:
            captured["middleware_kwargs"] = kwargs

    monkeypatch.setattr("deerflow.models.create_chat_model", fake_model)
    monkeypatch.setattr(
        "deerflow.agents.middlewares.summarization_middleware.DeerFlowSummarizationMiddleware",
        FakeMiddleware,
    )

    compression = ContextCompression(
        model_name="m",
        context_window=32768,
        input_budget=28672,
        trigger_tokens=25000,
        keep_tokens=8000,
        summary_model_name=None,
    )
    middleware = compression.build_middleware(app_config=SimpleNamespace())

    assert isinstance(middleware, FakeMiddleware)
    assert captured["model_kwargs"]["name"] == "m"
    kwargs = captured["middleware_kwargs"]
    assert kwargs["trigger"] == ("tokens", 25000)
    assert kwargs["keep"] == ("tokens", 8000)
    assert "{messages}" in kwargs["summary_prompt"]


def test_build_middleware_degrades_fail_open(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("deerflow.models.create_chat_model", lambda **kwargs: (_ for _ in ()).throw(RuntimeError("no model")))
    compression = ContextCompression(
        model_name="m",
        context_window=32768,
        input_budget=28672,
        trigger_tokens=25000,
        keep_tokens=8000,
    )
    assert compression.build_middleware(app_config=SimpleNamespace()) is None
