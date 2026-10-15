"""Tests for N14 §24.10 node-level model routing (:mod:`deerflow.workflow.routing`)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from deerflow.workflow.routing import (
    ModelInfo,
    RoutingError,
    RoutingPolicy,
    model_infos,
    parse_routing_policy,
    select_model,
)


class TestParseRoutingPolicy:
    def test_absent(self) -> None:
        assert parse_routing_policy({}) is None
        assert parse_routing_policy(None) is None

    def test_defaults(self) -> None:
        assert parse_routing_policy({"model_policy": {}}) == RoutingPolicy(prefer="default", require_local=False)

    def test_full(self) -> None:
        assert parse_routing_policy({"model_policy": {"prefer": "local", "require_local": True}}) == RoutingPolicy(prefer="local", require_local=True)

    @pytest.mark.parametrize("bad", [{"prefer": "fastest"}, {"require_local": "yes"}, {"nope": 1}, "local"])
    def test_bad(self, bad: Any) -> None:
        with pytest.raises(RoutingError):
            parse_routing_policy({"model_policy": bad})


class _Model:
    def __init__(self, name: str, *, local: bool = False, cost_tier: Any = 0) -> None:
        self.name = name
        self.local = local
        self.cost_tier = cost_tier


class TestModelInfos:
    def test_reads_fields(self) -> None:
        infos = model_infos([_Model("a", local=True, cost_tier=3), _Model("b")])
        assert infos == [ModelInfo("a", True, 3), ModelInfo("b", False, 0)]

    def test_skips_missing_name(self) -> None:
        assert model_infos([_Model(""), _Model("ok")]) == [ModelInfo("ok")]

    def test_bad_tier_defaults_zero(self) -> None:
        assert model_infos([_Model("a", cost_tier="high")]) == [ModelInfo("a")]

    def test_none(self) -> None:
        assert model_infos(None) == []


class TestSelectModel:
    def _pool(self) -> list[ModelInfo]:
        return [ModelInfo("cloud-big", False, 10), ModelInfo("local-small", True, 1), ModelInfo("cloud-cheap", False, 0)]

    def test_empty(self) -> None:
        assert select_model([], RoutingPolicy()) is None

    def test_default_takes_first(self) -> None:
        assert select_model(self._pool(), RoutingPolicy(prefer="default")).name == "cloud-big"

    def test_prefer_local(self) -> None:
        assert select_model(self._pool(), RoutingPolicy(prefer="local")).name == "local-small"

    def test_prefer_cheap(self) -> None:
        assert select_model(self._pool(), RoutingPolicy(prefer="cheap")).name == "cloud-cheap"

    def test_prefer_quality(self) -> None:
        assert select_model(self._pool(), RoutingPolicy(prefer="quality")).name == "cloud-big"

    def test_require_local_filters(self) -> None:
        pool = [ModelInfo("a", False, 0), ModelInfo("b", True, 5)]
        assert select_model(pool, RoutingPolicy(prefer="cheap", require_local=True)).name == "b"

    def test_require_local_none_raises(self) -> None:
        with pytest.raises(RoutingError):
            select_model([ModelInfo("a", False, 0)], RoutingPolicy(require_local=True))

    def test_deterministic_tie_break(self) -> None:
        pool = [ModelInfo("zeta", True, 1), ModelInfo("alpha", True, 1)]
        assert select_model(pool, RoutingPolicy(prefer="local")).name == "alpha"


# ── executor integration ─────────────────────────────────────────────────────


@dataclass
class _Status:
    value: str = "completed"


class _Result:
    status = _Status()
    result = "ok"
    token_usage_records: list[Any] | None = None
    stop_reason: str | None = None


@pytest.fixture
def fake_executor(monkeypatch: pytest.MonkeyPatch) -> Any:
    captured: dict[str, Any] = {}

    class FakeExecutor:
        def __init__(self, **kwargs: Any) -> None:
            captured["kwargs"] = kwargs

        async def _aexecute(self, task: str, result_holder: Any = None) -> Any:
            return _Result()

    import deerflow.subagents as subagents_pkg

    monkeypatch.setattr(subagents_pkg, "SubagentExecutor", FakeExecutor)
    monkeypatch.setattr("deerflow.workflow.executors.ai._resolve_node_tools", lambda *a, **k: [])
    monkeypatch.setattr("deerflow.workflow.prompts.load_agent_soul", lambda *a, **k: None)
    yield captured


def _runtime(app_config: Any) -> Any:
    from deerflow.workflow.compiler import WorkflowRuntime

    return WorkflowRuntime(context={"user_id": "u1", "thread_id": "t", "app_config": app_config})


class TestExecutorRouting:
    @pytest.mark.asyncio
    async def test_local_preference_selects_local_model(self, fake_executor: dict[str, Any]) -> None:
        from types import SimpleNamespace

        from deerflow.workflow.executors.ai import exec_llm_agent

        app_config = SimpleNamespace(models=[SimpleNamespace(name="cloud", local=False, cost_tier=5), SimpleNamespace(name="local", local=True, cost_tier=1)])
        await exec_llm_agent(_runtime(app_config), {"instruction": "hi", "node_id": "n", "model_policy": {"prefer": "local"}}, {})
        assert fake_executor["kwargs"]["config"].model == "local"

    @pytest.mark.asyncio
    async def test_no_policy_inherits(self, fake_executor: dict[str, Any]) -> None:
        from types import SimpleNamespace

        from deerflow.workflow.executors.ai import exec_llm_agent

        app_config = SimpleNamespace(models=[SimpleNamespace(name="cloud", local=False, cost_tier=5)])
        await exec_llm_agent(_runtime(app_config), {"instruction": "hi", "node_id": "n"}, {})
        assert fake_executor["kwargs"]["config"].model == "inherit"

    @pytest.mark.asyncio
    async def test_require_local_without_local_fails(self, fake_executor: dict[str, Any]) -> None:
        from types import SimpleNamespace

        from deerflow.workflow.executors.ai import exec_llm_agent
        from deerflow.workflow.registry import WorkflowExecutionError

        app_config = SimpleNamespace(models=[SimpleNamespace(name="cloud", local=False, cost_tier=5)])
        with pytest.raises(WorkflowExecutionError, match="require_local"):
            await exec_llm_agent(_runtime(app_config), {"instruction": "hi", "node_id": "n", "model_policy": {"require_local": True}}, {})

    @pytest.mark.asyncio
    async def test_bad_policy_fails(self, fake_executor: dict[str, Any]) -> None:
        from types import SimpleNamespace

        from deerflow.workflow.executors.ai import exec_llm_agent
        from deerflow.workflow.registry import WorkflowExecutionError

        app_config = SimpleNamespace(models=[SimpleNamespace(name="m")])
        with pytest.raises(WorkflowExecutionError, match="invalid model_policy"):
            await exec_llm_agent(_runtime(app_config), {"instruction": "hi", "node_id": "n", "model_policy": {"prefer": "nope"}}, {})
