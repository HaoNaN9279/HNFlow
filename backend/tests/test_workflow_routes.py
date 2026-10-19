"""Router tests for workflow definition CRUD endpoints."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI, Request, Response
from fastapi.testclient import TestClient
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

from app.gateway.routers import workflow_routes
from app.gateway.routers.workflow_routes import _resolve_workflow_metadata
from deerflow.config.database_config import DatabaseConfig
from deerflow.persistence.engine import close_engine, get_session_factory, init_engine_from_config
from deerflow.persistence.workflow_definitions import WorkflowDefinitionRepository
from deerflow.skills.types import Skill, SkillCategory
from deerflow.workflow.schema import Node, NodeType, WorkflowDefinition

# ── Fixtures ─────────────────────────────────────────────────────────────────

_VALID_DEFINITION = {
    "id": "wf-test-def",
    "name": "Test Workflow",
    "nodes": [
        {"id": "start", "type": "flow:start", "outputs": [{"name": "out", "type": "data"}]},
        {"id": "assign", "type": "data:assign", "inputs": [{"name": "in", "type": "data"}], "outputs": [{"name": "out", "type": "data"}]},
        {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}]},
    ],
    "edges": [
        {"source": "start", "source_port": "out", "target": "assign", "target_port": "in"},
        {"source": "assign", "source_port": "out", "target": "end", "target_port": "in"},
    ],
}

_CYCLE_DEFINITION = {
    "id": "cycle-wf",
    "name": "Cycle Workflow",
    "nodes": [
        {"id": "A", "type": "data:assign", "inputs": [{"name": "in", "type": "data"}], "outputs": [{"name": "out", "type": "data"}]},
        {"id": "B", "type": "data:assign", "inputs": [{"name": "in", "type": "data"}], "outputs": [{"name": "out", "type": "data"}]},
        {"id": "C", "type": "data:assign", "inputs": [{"name": "in", "type": "data"}], "outputs": [{"name": "out", "type": "data"}]},
    ],
    "edges": [
        {"source": "A", "source_port": "out", "target": "B", "target_port": "in"},
        {"source": "B", "source_port": "out", "target": "C", "target_port": "in"},
        {"source": "C", "source_port": "out", "target": "A", "target_port": "in"},
    ],
}

_INVALID_DEFINITION_MISSING_ID = {
    "name": "No ID Workflow",
    "nodes": [],
    "edges": [],
}

# Definition with capability_groups on one node
_DEFINITION_WITH_CAPABILITY_GROUPS = {
    "id": "wf-cap-groups",
    "name": "Workflow With Skills",
    "nodes": [
        {"id": "start", "type": "flow:start", "outputs": [{"name": "out", "type": "data"}]},
        {"id": "assign", "type": "data:assign", "inputs": [{"name": "in", "type": "data"}], "outputs": [{"name": "out", "type": "data"}], "capability_groups": ["data-analysis"]},
        {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}]},
    ],
    "edges": [
        {"source": "start", "source_port": "out", "target": "assign", "target_port": "in"},
        {"source": "assign", "source_port": "out", "target": "end", "target_port": "in"},
    ],
}

_STUB_PERMISSIONS: list[str] = []


# ── Custom stub middleware ────────────────────────────────────────────────────


class _WorkflowTestAuthMiddleware(BaseHTTPMiddleware):
    """Stamp a fake user onto every request."""

    def __init__(self, app: ASGIApp, user_factory: Callable[[], SimpleNamespace]) -> None:
        super().__init__(app)
        self._user_factory = user_factory

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        request.state.user = self._user_factory()
        return await call_next(request)


def _make_authed_workflow_app(repo, user_factory: Callable[[], SimpleNamespace] | None = None):
    """Build a FastAPI test app with stub identity + workflow repo on app.state."""
    from unittest.mock import AsyncMock, MagicMock

    factory = user_factory or _make_stub_user
    app = FastAPI()
    app.add_middleware(_WorkflowTestAuthMiddleware, user_factory=factory)
    app.state.workflow_definition_repo = repo

    # thread_store mock needed by the route module
    repo_mock = MagicMock()
    repo_mock.check_access = AsyncMock(return_value=True)
    app.state.thread_store = repo_mock

    app.include_router(workflow_routes.router)
    return app


def _make_stub_user() -> SimpleNamespace:
    # Use a stable id so that the same user is returned across multiple
    # requests within one test (POST + GET must share the same user_id).
    return SimpleNamespace(
        id="11111111-1111-1111-1111-111111111111",
        system_role="user",
    )


# ── Helpers ──────────────────────────────────────────────────────────────────


async def _make_repo(tmp_path):
    """Create a WorkflowDefinitionRepository backed by a tmp_path SQLite DB."""
    await init_engine_from_config(DatabaseConfig(backend="sqlite", sqlite_dir=str(tmp_path)))
    sf = get_session_factory()
    assert sf is not None
    return WorkflowDefinitionRepository(sf)


def _user_a() -> SimpleNamespace:
    return SimpleNamespace(
        id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        system_role="user",
    )


def _user_b() -> SimpleNamespace:
    return SimpleNamespace(
        id="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        system_role="user",
    )


# ── 5 端点注册 ───────────────────────────────────────────────────────────────


def test_router_registers_list_endpoint():
    """GET /api/workflows should not 404."""
    app = FastAPI()
    app.include_router(workflow_routes.router)
    client = TestClient(app)
    response = client.get("/api/workflows")
    assert response.status_code != 404


def test_router_registers_create_endpoint():
    """POST /api/workflows should not 404."""
    app = FastAPI()
    app.include_router(workflow_routes.router)
    client = TestClient(app)
    response = client.post("/api/workflows", json={"name": "test"})
    assert response.status_code != 404


def test_router_registers_get_by_id_endpoint():
    """GET /api/workflows/{id} should not 404."""
    app = FastAPI()
    app.include_router(workflow_routes.router)
    client = TestClient(app)
    response = client.get("/api/workflows/wf-123")
    assert response.status_code != 404


def test_router_registers_put_endpoint():
    """PUT /api/workflows/{id} should not 404."""
    app = FastAPI()
    app.include_router(workflow_routes.router)
    client = TestClient(app)
    response = client.put("/api/workflows/wf-123", json={})
    assert response.status_code != 404


def test_router_registers_delete_endpoint():
    """DELETE /api/workflows/{id} should not 404."""
    app = FastAPI()
    app.include_router(workflow_routes.router)
    client = TestClient(app)
    response = client.delete("/api/workflows/wf-123")
    assert response.status_code != 404


# ── POST 合法定义 201 + 落库 ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_post_valid_definition_returns_ok_and_persists(tmp_path):
    """POST with a valid definition returns 200/201 and the workflow appears in list."""
    repo = await _make_repo(tmp_path)
    app = _make_authed_workflow_app(repo)
    client = TestClient(app)

    payload = {"name": "Valid WF", "definition": _VALID_DEFINITION}
    response = client.post("/api/workflows", json=payload)
    assert response.status_code in (200, 201), f"Got {response.status_code}: {response.text}"
    data = response.json()
    assert data["name"] == "Valid WF"
    assert "id" in data
    assert data["id"].startswith("wf-")

    # Verify it appears in the list
    list_resp = client.get("/api/workflows")
    assert list_resp.status_code == 200
    items = list_resp.json()
    assert any(item["id"] == data["id"] for item in items)

    await close_engine()


# ── POST 环图 422 ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_post_cycle_definition_returns_422_with_cycle_path(tmp_path):
    """POST with a cycle (A→B→C→A) returns 422 with errors mentioning cycle path."""
    repo = await _make_repo(tmp_path)
    app = _make_authed_workflow_app(repo)
    client = TestClient(app)

    payload = {"name": "Cycle WF", "definition": _CYCLE_DEFINITION}
    response = client.post("/api/workflows", json=payload)
    assert response.status_code == 422, f"Got {response.status_code}: {response.text}"
    body = response.json()
    assert "errors" in body["detail"]
    errors = body["detail"]["errors"]
    assert len(errors) >= 1
    # At least one error should mention cycle-related nodes
    cycle_found = any("A" in e and "B" in e and "C" in e and "→" in e for e in errors)
    assert cycle_found, f"Expected cycle error mentioning A/B/C with arrows; got {errors}"

    await close_engine()


# ── POST 结构非法 422 ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_post_invalid_definition_missing_id_returns_422(tmp_path):
    """POST without required 'id' field returns 422."""
    repo = await _make_repo(tmp_path)
    app = _make_authed_workflow_app(repo)
    client = TestClient(app)

    payload = {"name": "Invalid WF", "definition": _INVALID_DEFINITION_MISSING_ID}
    response = client.post("/api/workflows", json=payload)
    assert response.status_code == 422, f"Got {response.status_code}: {response.text}"
    body = response.json()
    assert "errors" in body["detail"]
    errors = body["detail"]["errors"]
    # Should contain a validation error about missing fields or "定义结构非法"
    structural_msg = any("定义结构非法" in e or "id" in e.lower() for e in errors)
    assert structural_msg, f"Expected structural error; got {errors}"

    await close_engine()


# ── PUT 更新 + 重新校验 ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_put_updates_name_and_revalidates(tmp_path):
    """PUT a valid update → 200; PUT a cycle → 422; PUT non-existent → 404."""
    repo = await _make_repo(tmp_path)
    app = _make_authed_workflow_app(repo)
    client = TestClient(app)

    # POST a valid definition first
    payload = {"name": "Original Name", "definition": _VALID_DEFINITION}
    create_resp = client.post("/api/workflows", json=payload)
    assert create_resp.status_code in (200, 201)
    wf_id = create_resp.json()["id"]

    # GET the created workflow
    get_resp = client.get(f"/api/workflows/{wf_id}")
    assert get_resp.status_code == 200

    # PUT to update name
    put_resp = client.put(f"/api/workflows/{wf_id}", json={"name": "Updated Name"})
    assert put_resp.status_code == 200, f"Got {put_resp.status_code}: {put_resp.text}"
    assert put_resp.json()["name"] == "Updated Name"

    # PUT with a cycle definition → 422
    put_cycle = client.put(f"/api/workflows/{wf_id}", json={"definition": _CYCLE_DEFINITION})
    assert put_cycle.status_code == 422, f"Got {put_cycle.status_code}"
    assert "errors" in put_cycle.json()["detail"]

    # PUT non-existent id → 404
    put_missing = client.put("/api/workflows/wf-nonexistent", json={"name": "Ghost"})
    assert put_missing.status_code == 404

    await close_engine()


# ── GET 404 / DELETE 404 ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_and_delete_nonexistent_returns_404(tmp_path):
    """GET and DELETE for a non-existent id return 404."""
    repo = await _make_repo(tmp_path)
    app = _make_authed_workflow_app(repo)
    client = TestClient(app)

    get_resp = client.get("/api/workflows/wf-ghost")
    assert get_resp.status_code == 404

    delete_resp = client.delete("/api/workflows/wf-ghost")
    assert delete_resp.status_code == 404

    await close_engine()


# ── user 隔离（router 层） ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_router_user_isolation(tmp_path):
    """User A's workflows are invisible to User B through the router."""
    repo = await _make_repo(tmp_path)
    user_a = _user_a()
    user_b = _user_b()

    # Build app with user_a as the stub user
    app = _make_authed_workflow_app(repo, user_factory=lambda: user_a)
    client = TestClient(app)

    # POST as user_a
    payload = {"name": "Alice's Workflow", "definition": _VALID_DEFINITION}
    resp = client.post("/api/workflows", json=payload)
    assert resp.status_code in (200, 201)
    wf_id = resp.json()["id"]

    # GET list as user_a — should contain the workflow
    list_a = client.get("/api/workflows")
    assert list_a.status_code == 200
    ids_a = [item["id"] for item in list_a.json()]
    assert wf_id in ids_a

    # GET single as user_a — should return 200
    get_a = client.get(f"/api/workflows/{wf_id}")
    assert get_a.status_code == 200

    # Now simulate user_b's view by monkeypatching get_optional_user_from_request
    async def _return_user_b(request):
        return user_b

    with patch.object(workflow_routes, "get_optional_user_from_request", _return_user_b):
        # GET list as user_b — should NOT contain user_a's workflow
        list_b = client.get("/api/workflows")
        assert list_b.status_code == 200
        ids_b = [item["id"] for item in list_b.json()]
        assert wf_id not in ids_b

        # GET single as user_b — should return 404
        get_b = client.get(f"/api/workflows/{wf_id}")
        assert get_b.status_code == 404

    await close_engine()


# ── 503（repo 缺失） ──────────────────────────────────────────────────────────


def test_missing_repo_returns_503():
    """When workflow_definition_repo is not on app.state, requests return 503."""
    # Build app manually without setting workflow_definition_repo
    from unittest.mock import AsyncMock, MagicMock

    app = FastAPI()
    app.add_middleware(_WorkflowTestAuthMiddleware, user_factory=_make_stub_user)
    repo_mock = MagicMock()
    repo_mock.check_access = AsyncMock(return_value=True)
    app.state.thread_store = repo_mock
    # Deliberately do NOT set app.state.workflow_definition_repo
    app.include_router(workflow_routes.router)
    client = TestClient(app)

    for method, url, body in [
        ("get", "/api/workflows", None),
        ("post", "/api/workflows", {"name": "test", "definition": _VALID_DEFINITION}),
        ("get", "/api/workflows/wf-1", None),
        ("put", "/api/workflows/wf-1", {"name": "test"}),
        ("delete", "/api/workflows/wf-1", None),
    ]:
        resp = None
        if method == "get":
            resp = client.get(url)
        elif method == "post":
            resp = client.post(url, json=body)
        elif method == "put":
            resp = client.put(url, json=body)
        elif method == "delete":
            resp = client.delete(url)
        assert resp is not None
        assert resp.status_code == 503, f"{method.upper()} {url} returned {resp.status_code}, expected 503"


# ── Helpers for resolved_groups tests ──────────────────────────────────────────


def _make_skill(
    name: str,
    skill_id: str | None = None,
    version: str = "0.1.0",
) -> Skill:
    """Construct a minimal Skill for test catalogs."""
    return Skill(
        name=name,
        description=f"Skill {name}",
        license=None,
        skill_dir=Path("."),
        skill_file=Path("SKILL.md"),
        relative_path=Path("."),
        category=SkillCategory.CUSTOM,
        skill_id=skill_id,
        version=version,
    )


def _make_definition(*group_sets: list[str]) -> WorkflowDefinition:
    """Build a WorkflowDefinition with one node per group list."""
    nodes = [Node(id=f"n{i}", type=NodeType.FLOW_START, capability_groups=groups) for i, groups in enumerate(group_sets)]
    return WorkflowDefinition(id="test-wf", name="Test", nodes=nodes)


# ── Tests: _resolve_workflow_metadata ──────────────────────────────────────────


class TestResolveWorkflowMetadata:
    """Unit tests for _resolve_workflow_metadata helper."""

    def test_with_capability_groups_populates_resolved_groups(self):
        """Metadata gets resolved_groups populated when nodes have capability_groups."""
        mock_storage = MagicMock()
        mock_storage.load_skills.return_value = [
            _make_skill("data-analysis", skill_id="550e8400-e29b", version="0.2.0"),
        ]

        with patch("deerflow.skills.storage.get_or_new_skill_storage", return_value=mock_storage):
            definition = _make_definition(["data-analysis"])
            result = _resolve_workflow_metadata(definition, {"key": "val"})

        assert result["key"] == "val"
        assert result["resolved_groups"] == ["550e8400-e29b@v0.2.0"]

    def test_no_capability_groups_preserves_keys_and_attaches_lockfile(self):
        """No capability groups → user keys preserved, no resolved_groups, lockfile attached (C3)."""
        definition = _make_definition([])
        metadata = {"key": "val"}
        result = _resolve_workflow_metadata(definition, metadata)
        assert result is not metadata  # a fresh dict now carries the lockfile
        assert result["key"] == "val"
        assert "resolved_groups" not in result
        assert isinstance(result["lockfile"], dict)
        assert result["lockfile"]["workflow"] == {"id": "test-wf", "version": "0.1.0"}

    def test_unknown_skill_name_yields_none_resolved_groups(self):
        """Unknown capability group name → resolved_groups set to None."""
        mock_storage = MagicMock()
        mock_storage.load_skills.return_value = [
            _make_skill("known", skill_id="guid-known"),
        ]

        with patch("deerflow.skills.storage.get_or_new_skill_storage", return_value=mock_storage):
            definition = _make_definition(["unknown"])
            result = _resolve_workflow_metadata(definition, {})

        assert result["resolved_groups"] is None

    def test_storage_error_fail_open(self):
        """Storage failure → keys preserved, no resolved_groups; lockfile still attached (fail-open)."""
        with patch("deerflow.skills.storage.get_or_new_skill_storage", side_effect=RuntimeError("boom")):
            definition = _make_definition(["data-analysis"])
            metadata = {"existing": "data"}
            result = _resolve_workflow_metadata(definition, metadata)

        # Fail-open: the original keys survive and resolution is skipped.
        assert result["existing"] == "data"
        assert "resolved_groups" not in result
        assert isinstance(result["lockfile"], dict)

    def test_preserves_existing_metadata_keys(self):
        """Existing metadata keys survive resolution."""
        mock_storage = MagicMock()
        mock_storage.load_skills.return_value = [
            _make_skill("data-analysis", skill_id="550e8400-e29b"),
        ]

        with patch("deerflow.skills.storage.get_or_new_skill_storage", return_value=mock_storage):
            definition = _make_definition(["data-analysis"])
            result = _resolve_workflow_metadata(definition, {"custom_field": 42, "another": "keep"})

        assert result["custom_field"] == 42
        assert result["another"] == "keep"
        assert result["resolved_groups"] == ["550e8400-e29b@v0.1.0"]

    def test_empty_resolved_becomes_none(self):
        """When all capability_groups are unknown → resolved_groups becomes None (not empty list)."""
        mock_storage = MagicMock()
        mock_storage.load_skills.return_value = []  # no skills in catalog

        with patch("deerflow.skills.storage.get_or_new_skill_storage", return_value=mock_storage):
            definition = _make_definition(["missing"])
            result = _resolve_workflow_metadata(definition, {})

        assert result["resolved_groups"] is None

    def test_mixed_known_and_unknown(self):
        """Mixed groups: known resolves, unknown and no-id skipped."""
        mock_storage = MagicMock()
        mock_storage.load_skills.return_value = [
            _make_skill("known", skill_id="guid-known", version="0.1.0"),
            _make_skill("no-id", skill_id=None),
        ]

        with patch("deerflow.skills.storage.get_or_new_skill_storage", return_value=mock_storage):
            definition = _make_definition(["known", "unknown", "no-id"])
            result = _resolve_workflow_metadata(definition, {})

        assert result["resolved_groups"] == ["guid-known@v0.1.0"]


# ── Tests: create_workflow integration ─────────────────────────────────────────


class TestCreateWorkflowResolvedGroups:
    """Route-level tests: create_workflow passes resolved metadata to repo."""

    def _make_app_with_mock_repo(self, repo):
        """Build a test app with a mocked repo and stub auth."""
        from unittest.mock import MagicMock as MM

        app = FastAPI()
        app.add_middleware(_WorkflowTestAuthMiddleware, user_factory=_make_stub_user)
        app.state.workflow_definition_repo = repo
        repo_mock = MM()
        repo_mock.check_access = AsyncMock(return_value=True)
        app.state.thread_store = repo_mock
        app.include_router(workflow_routes.router)
        return app

    def test_create_passes_resolved_metadata_to_repo(self):
        """create_workflow calls repo.create with metadata including resolved_groups."""
        mock_repo = MagicMock()
        mock_repo.create = AsyncMock(return_value={"id": "wf-abc", "name": "Test"})
        mock_repo.list_by_user = AsyncMock(return_value=[])

        app = self._make_app_with_mock_repo(mock_repo)
        client = TestClient(app)

        # When _resolve_workflow_metadata runs, it needs skills storage.
        # Mock the whole helper to return a known result so we test the
        # integration point (metadata reaches repo.create).
        expected_meta = {"resolved_groups": ["guid@v0.1.0"]}

        with patch.object(workflow_routes, "_resolve_workflow_metadata", return_value=expected_meta):
            payload = {"name": "WF With Skills", "definition": _DEFINITION_WITH_CAPABILITY_GROUPS}
            response = client.post("/api/workflows", json=payload)

        assert response.status_code in (200, 201), f"Got {response.status_code}: {response.text}"
        mock_repo.create.assert_called_once()
        call_kwargs = mock_repo.create.call_args[1]
        assert call_kwargs["metadata"] is expected_meta

    def test_create_without_capability_groups_preserves_metadata_and_adds_lockfile(self):
        """No capability_groups → user keys preserved, no resolved_groups, lockfile attached (C3)."""
        mock_repo = MagicMock()
        mock_repo.create = AsyncMock(return_value={"id": "wf-abc", "name": "Test"})
        mock_repo.list_by_user = AsyncMock(return_value=[])

        app = self._make_app_with_mock_repo(mock_repo)
        client = TestClient(app)

        user_metadata = {"custom": "value"}
        payload = {"name": "Simple WF", "definition": _VALID_DEFINITION, "metadata": user_metadata}
        response = client.post("/api/workflows", json=payload)

        assert response.status_code in (200, 201), f"Got {response.status_code}: {response.text}"
        metadata = mock_repo.create.call_args[1]["metadata"]
        assert metadata["custom"] == "value"
        assert "resolved_groups" not in metadata
        assert isinstance(metadata["lockfile"], dict)


# ── Tests: update_workflow integration ─────────────────────────────────────────


class TestUpdateWorkflowResolvedGroups:
    """Route-level tests: update_workflow resolves metadata correctly."""

    def _make_app_with_mock_repo(self, repo):
        """Build a test app with a mocked repo and stub auth."""
        from unittest.mock import MagicMock as MM

        app = FastAPI()
        app.add_middleware(_WorkflowTestAuthMiddleware, user_factory=_make_stub_user)
        app.state.workflow_definition_repo = repo
        repo_mock = MM()
        repo_mock.check_access = AsyncMock(return_value=True)
        app.state.thread_store = repo_mock
        app.include_router(workflow_routes.router)
        return app

    def test_update_definition_re_resolves_metadata(self):
        """When definition changes, metadata is re-resolved from new definition."""
        mock_repo = MagicMock()
        mock_repo.get = AsyncMock(
            return_value={
                "id": "wf-123",
                "name": "Old",
                "definition": _VALID_DEFINITION,
                "metadata": {"resolved_groups": ["old-guid@v0.1.0"]},
            }
        )
        mock_repo.update = AsyncMock(return_value={"id": "wf-123", "name": "Updated"})
        mock_repo.list_by_user = AsyncMock(return_value=[])

        app = self._make_app_with_mock_repo(mock_repo)
        client = TestClient(app)

        new_meta = {"resolved_groups": ["new-guid@v0.2.0"]}

        with patch.object(workflow_routes, "_resolve_workflow_metadata", return_value=new_meta):
            response = client.put(
                "/api/workflows/wf-123",
                json={"definition": _DEFINITION_WITH_CAPABILITY_GROUPS},
            )

        assert response.status_code == 200, f"Got {response.status_code}: {response.text}"
        call_kwargs = mock_repo.update.call_args[1]
        assert call_kwargs["updates"]["metadata"] is new_meta

    def test_update_definition_with_explicit_metadata_uses_it_as_base(self):
        """When both definition and metadata are provided, body.metadata is used as base."""
        mock_repo = MagicMock()
        mock_repo.get = AsyncMock(
            return_value={
                "id": "wf-123",
                "name": "Old",
                "definition": _VALID_DEFINITION,
                "metadata": {"resolved_groups": ["stale@v0.1.0"]},
            }
        )
        mock_repo.update = AsyncMock(return_value={"id": "wf-123", "name": "Updated"})
        mock_repo.list_by_user = AsyncMock(return_value=[])

        app = self._make_app_with_mock_repo(mock_repo)
        client = TestClient(app)

        user_meta = {"resolved_groups": ["explicit@v1.0.0"], "version": "2"}
        expected_result = dict(user_meta)  # the helper would merge

        with patch.object(workflow_routes, "_resolve_workflow_metadata", return_value=expected_result) as mock_resolve:
            response = client.put(
                "/api/workflows/wf-123",
                json={"definition": _DEFINITION_WITH_CAPABILITY_GROUPS, "metadata": user_meta},
            )

        assert response.status_code == 200, f"Got {response.status_code}: {response.text}"
        # Helper called with user-provided metadata as base
        mock_resolve.assert_called_once()
        _call_model, base_meta_arg = mock_resolve.call_args[0]
        # Pydantic deserializes body.metadata into a new dict; compare value, not identity.
        assert base_meta_arg == user_meta

    def test_update_metadata_without_definition_passes_through(self):
        """When only metadata changes (no definition), it passes through unchanged."""
        mock_repo = MagicMock()
        mock_repo.get = AsyncMock(
            return_value={
                "id": "wf-123",
                "name": "Old",
                "definition": _VALID_DEFINITION,
                "metadata": {"custom": "old"},
            }
        )
        mock_repo.update = AsyncMock(return_value={"id": "wf-123", "name": "Old", "metadata": {"custom": "new"}})

        app = self._make_app_with_mock_repo(mock_repo)
        client = TestClient(app)

        # Patch to verify it's NOT called
        with patch.object(workflow_routes, "_resolve_workflow_metadata") as mock_resolve:
            response = client.put(
                "/api/workflows/wf-123",
                json={"metadata": {"custom": "new"}},
            )

        assert response.status_code == 200, f"Got {response.status_code}: {response.text}"
        # _resolve_workflow_metadata should NOT be called when definition is not provided
        mock_resolve.assert_not_called()
        call_kwargs = mock_repo.update.call_args[1]
        assert call_kwargs["updates"]["metadata"] == {"custom": "new"}

    def test_update_definition_without_existing_metadata_uses_empty_base(self):
        """When existing has no metadata key, empty dict is used as base."""
        mock_repo = MagicMock()
        mock_repo.get = AsyncMock(
            return_value={
                "id": "wf-123",
                "name": "Old",
                "definition": _VALID_DEFINITION,
                # No "metadata" key in existing
            }
        )
        mock_repo.update = AsyncMock(return_value={"id": "wf-123", "name": "Updated"})
        mock_repo.list_by_user = AsyncMock(return_value=[])

        app = self._make_app_with_mock_repo(mock_repo)
        client = TestClient(app)

        expected_meta = {"resolved_groups": ["guid@v0.1.0"]}

        with patch.object(workflow_routes, "_resolve_workflow_metadata", return_value=expected_meta) as mock_resolve:
            response = client.put(
                "/api/workflows/wf-123",
                json={"definition": _DEFINITION_WITH_CAPABILITY_GROUPS},
            )

        assert response.status_code == 200, f"Got {response.status_code}: {response.text}"
        _call_model, base_meta_arg = mock_resolve.call_args[0]
        assert base_meta_arg == {}  # empty dict when existing has no metadata


@pytest.mark.asyncio
async def test_create_rejects_semantically_invalid_definition(tmp_path):
    """A structurally valid definition that cannot compile is rejected at save."""
    repo = await _make_repo(tmp_path)
    app = _make_authed_workflow_app(repo)
    client = TestClient(app)

    bad = {
        "id": "wf-semantic-bad",
        "name": "Bad semantics",
        "nodes": [
            {"id": "start", "type": "flow:start", "outputs": [{"name": "out", "type": "data"}]},
            {
                "id": "ai",
                "type": "ai:llm_agent",
                "inputs": [{"name": "in", "type": "data"}],
                "outputs": [{"name": "out", "type": "data"}],
                "params": {"instruction": "x", "context_policy": {"include": ["missing"]}},
            },
            {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}]},
        ],
        "edges": [
            {"source": "start", "source_port": "out", "target": "ai", "target_port": "in"},
            {"source": "ai", "source_port": "out", "target": "end", "target_port": "in"},
        ],
    }

    with patch("app.gateway.deps.get_app_config", return_value=MagicMock()):
        response = client.post("/api/workflows", json={"name": "bad", "definition": bad})

    assert response.status_code == 422
    assert "context_policy" in response.text
    await close_engine()
