"""Tests for the N14 §24.6b workflow-templates endpoint."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.routers import workflow_routes


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(workflow_routes.router)
    return TestClient(app)


def test_templates_endpoint_lists_builtins() -> None:
    response = _client().get("/api/workflows/templates")
    assert response.status_code == 200
    data = response.json()
    names = {entry["name"] for entry in data}
    assert names == {"critic_review_loop", "supervisor_topology"}
    for entry in data:
        assert entry["description"]


def test_template_definitions_deserialize() -> None:
    from deerflow.workflow.workflow_io import deserialize

    for entry in _client().get("/api/workflows/templates").json():
        definition = deserialize(entry["definition"])
        assert definition.nodes
        assert definition.edges


def test_templates_path_not_shadowed_by_definition_route() -> None:
    # `/workflows/templates` must not be interpreted as a `{definition_id}` read.
    response = _client().get("/api/workflows/templates")
    assert response.status_code == 200
    assert isinstance(response.json(), list)


def test_unknown_template_name_raises() -> None:
    import pytest

    from deerflow.workflow.patterns import build_template

    with pytest.raises(KeyError):
        build_template("does-not-exist")
