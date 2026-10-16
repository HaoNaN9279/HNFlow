"""Tests for N14 §24.10 workflow run cost reporting (`deerflow.workflow.costs`).

Two layers:

* pure logic — pricing map assembly, mixed-currency refusal, cache-aware
  pricing, usage extraction from state, and the run report;
* the route — ``GET /api/workflows/{id}/runs/{rid}/cost`` against a FastAPI
  app with mock singletons (503 without a checkpointer, a priced report with
  one).
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from langgraph.checkpoint.memory import InMemorySaver

from deerflow.runtime.runs.manager import RunManager
from deerflow.runtime.runs.worker import RunContext
from deerflow.workflow.costs import (
    ModelPricing,
    build_pricing_map,
    build_run_cost_report,
    lookup_pricing,
    node_usage_from_state,
    pricing_currency,
    token_cost,
)

# ── fixtures / helpers ────────────────────────────────────────────────────────

#: A minimal two-node definition the workflow run routes can validate + compile.
_VALID_DEFINITION_DICT = {
    "id": "wf-test-def",
    "name": "Test Workflow",
    "nodes": [
        {"id": "start", "type": "flow:start", "outputs": [{"name": "input", "type": "data"}]},
        {"id": "assign", "type": "data:assign", "inputs": [{"name": "in", "type": "data"}], "outputs": [{"name": "out", "type": "data"}]},
        {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}]},
    ],
    "edges": [
        {"source": "start", "source_port": "input", "target": "assign", "target_port": "in"},
        {"source": "assign", "source_port": "out", "target": "end", "target_port": "in"},
    ],
}


def _model(name: str, *, model: str | None = None, pricing: Any = None) -> SimpleNamespace:
    return SimpleNamespace(name=name, model=model or name, pricing=pricing)


def _usage(input_tokens: int = 0, output_tokens: int = 0, cache_read_tokens: int = 0) -> dict[str, int]:
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": input_tokens + output_tokens,
        "cache_read_tokens": cache_read_tokens,
    }


USD_PRICING = {"currency": "USD", "input_per_million": 3.0, "output_per_million": 15.0}


# ── pricing map ───────────────────────────────────────────────────────────────


class TestBuildPricingMap:
    def test_keys_name_and_provider_model_both_cases(self) -> None:
        models = [_model("Fast", model="gpt-4o-mini", pricing=USD_PRICING)]
        pricing = build_pricing_map(models)
        assert set(pricing) == {"Fast", "fast", "gpt-4o-mini"}
        assert pricing["Fast"] == pricing["gpt-4o-mini"]

    def test_skips_models_without_pricing_or_with_zero_prices(self) -> None:
        models = [
            _model("none"),
            _model("zeroth", pricing={"currency": "USD", "input_per_million": 0, "output_per_million": 0}),
            _model("real", pricing=USD_PRICING),
        ]
        assert set(build_pricing_map(models)) == {"real", "real"}

    def test_malformed_pricing_values_are_ignored_not_raised(self) -> None:
        models = [_model("bad", pricing={"currency": "USD", "input_per_million": "oops", "output_per_million": None})]
        assert build_pricing_map(models) == {}

    def test_non_dict_pricing_is_ignored(self) -> None:
        assert build_pricing_map([_model("weird", pricing="3.0")]) == {}

    def test_mixed_currencies_disable_reporting(self) -> None:
        models = [
            _model("a", pricing={"currency": "USD", "input_per_million": 1.0}),
            _model("b", pricing={"currency": "CNY", "input_per_million": 1.0}),
        ]
        assert build_pricing_map(models) == {}

    def test_currency_defaults_to_usd_and_is_upper_cased(self) -> None:
        assert pricing_currency(build_pricing_map([_model("a", pricing={"input_per_million": 1.0})])) == "USD"
        assert pricing_currency(build_pricing_map([_model("a", pricing={"currency": " eur ", "input_per_million": 1.0})])) == "EUR"

    def test_cache_hit_price_parsed_or_none(self) -> None:
        pricing = build_pricing_map([_model("a", pricing={**USD_PRICING, "input_cache_hit_per_million": 0.3})])
        assert pricing["a"].input_cache_hit_per_million == 0.3
        pricing = build_pricing_map([_model("a", pricing=USD_PRICING)])
        assert pricing["a"].input_cache_hit_per_million is None

    def test_empty_and_none_models(self) -> None:
        assert build_pricing_map([]) == {}
        assert build_pricing_map(None) == {}

    def test_pricing_currency_none_when_unpriced(self) -> None:
        assert pricing_currency({}) is None


class TestLookupPricing:
    def test_matches_exact_and_case_insensitively(self) -> None:
        pricing = build_pricing_map([_model("Fast", model="gpt-4o-mini", pricing=USD_PRICING)])
        assert lookup_pricing(pricing, "Fast") is not None
        assert lookup_pricing(pricing, "FAST") is not None
        assert lookup_pricing(pricing, "GPT-4O-MINI") is not None

    def test_unknown_or_missing_model_is_none(self) -> None:
        pricing = build_pricing_map([_model("a", pricing=USD_PRICING)])
        assert lookup_pricing(pricing, "nope") is None
        assert lookup_pricing(pricing, None) is None
        assert lookup_pricing(pricing, "") is None


class TestTokenCost:
    PRICE = ModelPricing(3.0, 15.0, "USD", None)

    def test_plain_pricing(self) -> None:
        assert token_cost(1_000_000, 1_000_000, self.PRICE) == 18.0

    def test_cache_hits_billed_at_hit_price(self) -> None:
        price = ModelPricing(3.0, 15.0, "USD", 0.3)
        # 1M input of which 500k are cache hits: 0.5*3 + 0.5*0.3 + 1*15
        assert token_cost(1_000_000, 1_000_000, price, cache_read_tokens=500_000) == 16.65

    def test_cache_read_clamped_to_input_range(self) -> None:
        price = ModelPricing(3.0, 15.0, "USD", 0.3)
        # Over-reported hits cannot make input negative or discount beyond input.
        assert token_cost(1_000_000, 0, price, cache_read_tokens=9_999_999) == 0.3
        assert token_cost(1_000_000, 0, price, cache_read_tokens=-5) == 3.0

    def test_zero_usage_is_zero(self) -> None:
        assert token_cost(0, 0, self.PRICE) == 0.0


# ── usage extraction ──────────────────────────────────────────────────────────


class TestNodeUsageFromState:
    def test_extracts_only_reserved_usage_channels(self) -> None:
        state = {
            "wf:n1:__token_usage": _usage(100, 20),
            "wf:n1:out": "text",
            "wf:n2:__token_usage": _usage(1, 2, 3),
            "wf:shared:board": {},
            "other": 1,
        }
        usage = node_usage_from_state(state)
        assert set(usage) == {"n1", "n2"}
        assert usage["n1"]["input_tokens"] == 100
        assert usage["n2"]["cache_read_tokens"] == 3

    def test_skips_non_dict_and_empty_node_ids(self) -> None:
        state = {"wf:n1:__token_usage": None, "wf::__token_usage": _usage(1, 1)}
        assert node_usage_from_state(state) == {}

    def test_malformed_fields_become_zero(self) -> None:
        state = {"wf:n1:__token_usage": {"input_tokens": "x", "output_tokens": None, "total_tokens": 5}}
        usage = node_usage_from_state(state)
        assert usage["n1"] == {"input_tokens": 0, "output_tokens": 0, "total_tokens": 5, "cache_read_tokens": 0}

    def test_non_mapping_state_is_empty(self) -> None:
        assert node_usage_from_state(None) == {}
        assert node_usage_from_state(["wf:n1:__token_usage"]) == {}


# ── run report ────────────────────────────────────────────────────────────────


class TestBuildRunCostReport:
    MODELS = [_model("default-model", model="gpt-4o-mini", pricing=USD_PRICING)]

    def test_prices_every_node_with_the_default_model(self) -> None:
        state = {"wf:a:__token_usage": _usage(1_000_000, 0), "wf:b:__token_usage": _usage(0, 1_000_000)}
        report = build_run_cost_report(state, self.MODELS, default_model="default-model")
        assert report["currency"] == "USD"
        assert report["priced_nodes"] == 2
        assert report["unpriced_nodes"] == []
        assert report["total_cost"] == 18.0
        assert [node["node_id"] for node in report["nodes"]] == ["a", "b"]
        assert report["nodes"][0]["cost"] == 3.0
        assert report["nodes"][1]["cost"] == 15.0
        assert report["token_usage"] == {"input_tokens": 1_000_000, "output_tokens": 1_000_000, "total_tokens": 2_000_000, "cache_read_tokens": 0}

    def test_per_node_model_override_wins(self) -> None:
        models = [
            _model("default-model", pricing=USD_PRICING),
            _model("cheap", model="cheap-model", pricing={"currency": "USD", "input_per_million": 1.0, "output_per_million": 1.0}),
        ]
        state = {"wf:a:__token_usage": _usage(1_000_000, 0)}
        report = build_run_cost_report(state, models, default_model="default-model", model_by_node={"a": "cheap"})
        assert report["nodes"][0]["model"] == "cheap"
        assert report["total_cost"] == 1.0

    def test_unpriced_model_yields_null_cost_not_zero(self) -> None:
        state = {"wf:a:__token_usage": _usage(1_000_000, 0)}
        report = build_run_cost_report(state, self.MODELS, default_model="unknown-model")
        assert report["nodes"][0]["cost"] is None
        assert report["total_cost"] is None
        assert report["unpriced_nodes"] == ["a"]
        assert report["priced_nodes"] == 0

    def test_no_pricing_configured_reports_nulls(self) -> None:
        state = {"wf:a:__token_usage": _usage(1_000_000, 0)}
        report = build_run_cost_report(state, [], default_model="m")
        assert report["currency"] is None
        assert report["total_cost"] is None
        assert report["unpriced_nodes"] == ["a"]
        # Token usage is still reported even without prices.
        assert report["token_usage"]["input_tokens"] == 1_000_000

    def test_mixed_models_partially_priced(self) -> None:
        models = [_model("default-model", pricing=USD_PRICING)]
        state = {"wf:a:__token_usage": _usage(1_000_000, 0), "wf:b:__token_usage": _usage(1_000_000, 0)}
        report = build_run_cost_report(state, models, default_model="default-model", model_by_node={"b": "unpriced"})
        assert report["priced_nodes"] == 1
        assert report["unpriced_nodes"] == ["b"]
        assert report["total_cost"] == 3.0

    def test_mixed_currency_config_disables_cost(self) -> None:
        models = [
            _model("default-model", pricing={"currency": "USD", "input_per_million": 3.0}),
            _model("other", pricing={"currency": "CNY", "input_per_million": 3.0}),
        ]
        state = {"wf:a:__token_usage": _usage(1_000_000, 0)}
        report = build_run_cost_report(state, models, default_model="default-model")
        assert report["total_cost"] is None
        assert report["currency"] is None

    def test_no_usage_nodes_reports_empty(self) -> None:
        report = build_run_cost_report({"wf:a:out": "x"}, self.MODELS, default_model="default-model")
        assert report["nodes"] == []
        assert report["total_cost"] is None
        assert report["token_usage"] == {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "cache_read_tokens": 0}

    def test_report_is_json_serialisable(self) -> None:
        import json

        state = {"wf:a:__token_usage": _usage(5, 6, 1)}
        report = build_run_cost_report(state, self.MODELS, default_model="default-model")
        json.dumps(report)  # must not raise


# ── route ─────────────────────────────────────────────────────────────────────


def _make_stub_user() -> SimpleNamespace:
    return SimpleNamespace(
        id="11111111-1111-1111-1111-111111111111",
        system_role="user",
    )


def _make_cost_route_app(checkpointer=None):
    from app.gateway.routers import workflow_run_routes

    app = FastAPI()

    class _AuthMiddleware:
        def __init__(self, app_):
            self.app = app_

        async def __call__(self, scope, receive, send):
            if scope["type"] != "http":
                await self.app(scope, receive, send)
                return
            from starlette.requests import Request as StarletteRequest

            request = StarletteRequest(scope, receive)
            request.state.user = _make_stub_user()
            await self.app(scope, receive, send)

    app.add_middleware(_AuthMiddleware)

    run_mgr = RunManager()
    thread_store = AsyncMock()
    thread_store.check_access = AsyncMock(return_value=True)

    mock_bridge = MagicMock()
    mock_bridge.publish = AsyncMock()
    mock_bridge.publish_end = AsyncMock()
    mock_bridge.cleanup = AsyncMock()
    mock_bridge.supports_cross_process = False

    app.state.stream_bridge = mock_bridge
    app.state.run_manager = run_mgr
    app.state.run_context = RunContext(checkpointer=checkpointer, thread_store=thread_store)
    app.state.thread_store = thread_store
    mock_repo = AsyncMock()
    mock_repo.get = AsyncMock(return_value={"definition": _VALID_DEFINITION_DICT})
    app.state.workflow_definition_repo = mock_repo
    app.state.checkpointer = checkpointer
    app.state.run_event_store = AsyncMock()

    app.include_router(workflow_run_routes.router)
    return app


def _models_with_pricing():
    return [_model("default-model", model="gpt-4o-mini", pricing=USD_PRICING)]


def _create_run(client: TestClient) -> str:
    with patch("app.gateway.deps.get_app_config", return_value=MagicMock()):
        resp = client.post("/api/workflows/wf-test-def/runs", json={"params": {"input": "hi"}})
    assert resp.status_code in (200, 201), f"Got {resp.status_code}: {resp.text}"
    return resp.json()["run_id"]


class TestCostRoute:
    def test_no_checkpointer_returns_503(self) -> None:
        # The run must exist first (run creation itself needs a checkpointer),
        # so create it on a working app and then strip the checkpointer.
        app = _make_cost_route_app(checkpointer=InMemorySaver())
        client = TestClient(app)
        run_id = _create_run(client)
        app.state.checkpointer = None
        app.state.run_context = RunContext(checkpointer=None, thread_store=app.state.thread_store)
        with patch("app.gateway.deps.get_app_config", return_value=MagicMock()):
            resp = client.get(f"/api/workflows/wf-test-def/runs/{run_id}/cost")
        assert resp.status_code == 503, f"Got {resp.status_code}: {resp.text}"

    def test_unknown_run_returns_404(self) -> None:
        app = _make_cost_route_app(checkpointer=InMemorySaver())
        client = TestClient(app)
        resp = client.get("/api/workflows/wf-test-def/runs/does-not-exist/cost")
        assert resp.status_code == 404, f"Got {resp.status_code}: {resp.text}"

    def test_priced_report_for_a_run_with_usage(self) -> None:
        checkpointer = AsyncMock()
        snapshot = SimpleNamespace(channel_values={"wf:n1:__token_usage": _usage(1_000_000, 1_000_000)})
        checkpointer.aget_tuple = AsyncMock(return_value=snapshot)
        app = _make_cost_route_app(checkpointer=checkpointer)
        client = TestClient(app)
        run_id = _create_run(client)

        config = MagicMock()
        config.models = _models_with_pricing()
        with (
            patch("app.gateway.deps.get_app_config", return_value=MagicMock()),
            patch("app.gateway.routers.workflow_run_routes.get_app_config", return_value=config),
        ):
            resp = client.get(f"/api/workflows/wf-test-def/runs/{run_id}/cost")
        assert resp.status_code == 200, f"Got {resp.status_code}: {resp.text}"
        body = resp.json()
        assert body["run_id"] == run_id
        assert body["definition_id"] == "wf-test-def"
        assert body["currency"] == "USD"
        assert body["total_cost"] == 18.0
        assert body["nodes"][0]["node_id"] == "n1"
        assert body["nodes"][0]["model"] == "default-model"

    def test_empty_checkpoint_returns_zero_usage(self) -> None:
        checkpointer = AsyncMock()
        checkpointer.aget_tuple = AsyncMock(return_value=None)
        app = _make_cost_route_app(checkpointer=checkpointer)
        client = TestClient(app)
        run_id = _create_run(client)

        config = MagicMock()
        config.models = _models_with_pricing()
        with (
            patch("app.gateway.deps.get_app_config", return_value=MagicMock()),
            patch("app.gateway.routers.workflow_run_routes.get_app_config", return_value=config),
        ):
            resp = client.get(f"/api/workflows/wf-test-def/runs/{run_id}/cost")
        assert resp.status_code == 200
        body = resp.json()
        assert body["nodes"] == []
        assert body["total_cost"] is None


class TestCostRouteHelper:
    def test_config_failure_does_not_break_the_route(self) -> None:
        checkpointer = AsyncMock()
        snapshot = SimpleNamespace(channel_values={"wf:n1:__token_usage": _usage(10, 10)})
        checkpointer.aget_tuple = AsyncMock(return_value=snapshot)
        app = _make_cost_route_app(checkpointer=checkpointer)
        client = TestClient(app)
        run_id = _create_run(client)

        with (
            patch("app.gateway.deps.get_app_config", return_value=MagicMock()),
            patch("app.gateway.routers.workflow_run_routes.get_app_config", side_effect=RuntimeError("boom")),
        ):
            resp = client.get(f"/api/workflows/wf-test-def/runs/{run_id}/cost")
        assert resp.status_code == 200, f"Got {resp.status_code}: {resp.text}"
        assert resp.json()["total_cost"] is None
