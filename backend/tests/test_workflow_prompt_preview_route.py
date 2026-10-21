"""Route test for the static prompt-preview endpoint."""

from __future__ import annotations

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.routers import workflow_routes


def _definition() -> dict:
    return {
        "id": "wf-preview",
        "name": "Preview",
        "version": "0.1.0",
        "nodes": [
            {"id": "start", "type": "flow:start", "outputs": [{"name": "out", "type": "data"}]},
            {
                "id": "ai",
                "type": "ai:llm_agent",
                "capability_groups": ["alpha"],
                "inputs": [{"name": "in", "type": "data"}, {"name": "template_prompt", "type": "data"}],
                "outputs": [{"name": "out", "type": "data"}],
            },
            {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}]},
        ],
        "edges": [
            {"source": "start", "source_port": "out", "target": "ai", "target_port": "in"},
            {"source": "start", "source_port": "out", "target": "ai", "target_port": "template_prompt"},
            {"source": "ai", "source_port": "out", "target": "end", "target_port": "in"},
        ],
    }


def _client(monkeypatch) -> TestClient:
    async def _user(_request):
        return SimpleNamespace(id="default")

    monkeypatch.setattr(workflow_routes, "get_optional_user_from_request", _user)
    app = FastAPI()
    app.include_router(workflow_routes.router)
    return TestClient(app)


def test_prompt_preview_returns_assembled_prompt(monkeypatch) -> None:
    monkeypatch.setattr(
        "deerflow.workflow.prompt_preview.load_capability_rules",
        lambda groups, user_id=None: [],
    )
    monkeypatch.setattr(
        "deerflow.workflow.prompt_preview.load_capability_skills",
        lambda groups, user_id=None: [],
    )
    response = _client(monkeypatch).post(
        "/api/workflows/wf-preview/prompt-preview",
        json={"node_id": "ai", "definition": _definition()},
    )

    assert response.status_code == 200
    body = response.json()
    assert "alpha" in body["prompt"]
    assert body["capability_groups"] == ["alpha"]
    assert [component["key"] for component in body["components"]] == [
        "identity",
        "capability",
        "template_prompt",
    ]
    assert body["omitted_runtime_blocks"] == ["template_prompt"]
    assert all(component["editable"] is False for component in body["components"])


def test_prompt_preview_rejects_unknown_node(monkeypatch) -> None:
    response = _client(monkeypatch).post(
        "/api/workflows/wf-preview/prompt-preview",
        json={"node_id": "missing", "definition": _definition()},
    )

    assert response.status_code == 422
