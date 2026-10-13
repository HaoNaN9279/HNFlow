"""Route tests for T11-2: workflow dependency-cycle rejection on save.

Covers the ``create_workflow`` / ``update_workflow`` integration of the
``_check_workflow_dependency_cycles`` helper: workflow→workflow cycles,
capability-group cycles, scope isolation, and skills-storage fail-open.
Uses a mock repository (FastAPI TestClient + dependency injection) following
the pattern established in ``test_workflow_routes.py``.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import FastAPI, Request, Response
from fastapi.testclient import TestClient
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

from app.gateway.routers import workflow_routes
from deerflow.skills.types import DependencySpec, Skill, SkillCategory

# ── Auth stub (mirrors test_workflow_routes.py) ───────────────────────────────

_STUB_PERMISSIONS: list[str] = []


class _WorkflowTestAuthMiddleware(BaseHTTPMiddleware):
    """Stamp a fake user onto every request."""

    def __init__(self, app: ASGIApp, user_factory: Callable[[], SimpleNamespace]) -> None:
        super().__init__(app)
        self._user_factory = user_factory

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        request.state.user = self._user_factory()
        return await call_next(request)


def _make_stub_user() -> SimpleNamespace:
    return SimpleNamespace(
        id="11111111-1111-1111-1111-111111111111",
        system_role="user",
    )


def _make_authed_workflow_app(repo, user_factory: Callable[[], SimpleNamespace] | None = None):
    """Build a FastAPI test app with stub identity + workflow repo on app.state."""
    factory = user_factory or _make_stub_user
    app = FastAPI()
    app.add_middleware(_WorkflowTestAuthMiddleware, user_factory=factory)
    app.state.workflow_definition_repo = repo

    repo_mock = MagicMock()
    repo_mock.check_access = AsyncMock(return_value=True)
    app.state.thread_store = repo_mock

    app.include_router(workflow_routes.router)
    return app


# ── Definition builders ───────────────────────────────────────────────────────


def _plain_def(wf_id: str) -> dict:
    """A minimal valid start→end workflow with no sub-workflow references."""
    return {
        "id": wf_id,
        "name": f"WF {wf_id}",
        "nodes": [
            {"id": "start", "type": "flow:start", "outputs": [{"name": "out", "type": "data"}]},
            {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}]},
        ],
        "edges": [{"source": "start", "source_port": "out", "target": "end", "target_port": "in"}],
    }


def _subworkflow_def(wf_id: str, template_id: str) -> dict:
    """A valid workflow whose single ``nested:subworkflow`` node references *template_id*."""
    return {
        "id": wf_id,
        "name": f"WF {wf_id}",
        "nodes": [
            {"id": "start", "type": "flow:start", "outputs": [{"name": "out", "type": "data"}]},
            {
                "id": "sub",
                "type": "nested:subworkflow",
                "inputs": [{"name": "in", "type": "data"}],
                "outputs": [{"name": "out", "type": "data"}],
                "params": {"subworkflow": {"type": "template", "template_id": template_id}},
            },
            {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}]},
        ],
        "edges": [
            {"source": "start", "source_port": "out", "target": "sub", "target_port": "in"},
            {"source": "sub", "source_port": "out", "target": "end", "target_port": "in"},
        ],
    }


def _capability_group_def(wf_id: str, group_names: list[str]) -> dict:
    """A valid workflow with one ``data:assign`` node carrying *group_names*."""
    return {
        "id": wf_id,
        "name": f"WF {wf_id}",
        "nodes": [
            {"id": "start", "type": "flow:start", "outputs": [{"name": "out", "type": "data"}]},
            {
                "id": "assign",
                "type": "data:assign",
                "inputs": [{"name": "in", "type": "data"}],
                "outputs": [{"name": "out", "type": "data"}],
                "capability_groups": group_names,
            },
            {"id": "end", "type": "flow:end", "inputs": [{"name": "in", "type": "data"}]},
        ],
        "edges": [
            {"source": "start", "source_port": "out", "target": "assign", "target_port": "in"},
            {"source": "assign", "source_port": "out", "target": "end", "target_port": "in"},
        ],
    }


def _make_skill(
    name: str,
    skill_id: str | None = None,
    version: str = "0.1.0",
    dependencies: tuple[DependencySpec, ...] | None = None,
) -> Skill:
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
        dependencies=dependencies,
    )


def _mock_repo(*, list_rows: list[dict] | None = None, get_row: dict | None = None) -> MagicMock:
    """Build a mock WorkflowDefinitionRepository with controllable responses."""
    repo = MagicMock()
    repo.list_by_user = AsyncMock(return_value=list_rows if list_rows is not None else [])
    repo.get = AsyncMock(return_value=get_row)
    repo.create = AsyncMock(return_value={"id": "wf-created", "name": "created"})
    repo.update = AsyncMock(return_value={"id": "wf-updated", "name": "updated"})
    return repo


# ── Create: workflow cycle ────────────────────────────────────────────────────


def test_create_workflow_cycle_returns_422():
    """POST a workflow whose sub-workflow refs close a cycle with a stored workflow → 422."""
    fixed_hex = "deadbeefdeadbeefdeadbeefdeadbeef"
    target_id = f"wf-{fixed_hex}"
    # Stored workflow "wf-b" references the to-be-created workflow's DB id.
    b_def = _subworkflow_def("wf-b", template_id=target_id)
    repo = _mock_repo(list_rows=[{"id": "wf-b", "definition": b_def}])

    app = _make_authed_workflow_app(repo)
    client = TestClient(app)

    a_def = _subworkflow_def("wf-a", template_id="wf-b")
    with patch("uuid.uuid4", return_value=uuid.UUID(fixed_hex)):
        response = client.post("/api/workflows", json={"name": "A", "definition": a_def})

    assert response.status_code == 422, f"Got {response.status_code}: {response.text}"
    errors = response.json()["detail"]["errors"]
    assert len(errors) >= 1
    assert any(e.startswith("依赖环:") for e in errors), f"Expected 依赖环 prefix; got {errors}"
    assert any("workflow:" in e for e in errors), f"Expected workflow: node in cycle path; got {errors}"
    repo.create.assert_not_called()


def test_create_valid_no_cycle_succeeds():
    """A cycle-free definition (dangling template ref) saves successfully — zero regression."""
    repo = _mock_repo(list_rows=[])
    app = _make_authed_workflow_app(repo)
    client = TestClient(app)

    # References a non-existent workflow → no edge → no cycle.
    definition = _subworkflow_def("wf-a", template_id="wf-missing")
    response = client.post("/api/workflows", json={"name": "A", "definition": definition})

    assert response.status_code in (200, 201), f"Got {response.status_code}: {response.text}"
    repo.create.assert_called_once()


# ── Update: cycle removal / introduction / name-only ─────────────────────────


def test_update_removing_cycle_succeeds():
    """Replacing the target with a cycle-free definition clears a stored cycle → 200."""
    a_cyclic = _subworkflow_def("wf-a", template_id="wf-b")
    b_def = _subworkflow_def("wf-b", template_id="wf-a")
    repo = _mock_repo(
        list_rows=[{"id": "wf-a", "definition": a_cyclic}, {"id": "wf-b", "definition": b_def}],
        get_row={"id": "wf-a", "name": "A", "definition": a_cyclic, "metadata": {}},
    )

    app = _make_authed_workflow_app(repo)
    client = TestClient(app)

    response = client.put("/api/workflows/wf-a", json={"definition": _plain_def("wf-a")})

    assert response.status_code == 200, f"Got {response.status_code}: {response.text}"
    repo.update.assert_called_once()


def test_update_introducing_cycle_returns_422():
    """Updating the target to reference a stored workflow that references it back → 422."""
    a_plain = _plain_def("wf-a")
    b_def = _subworkflow_def("wf-b", template_id="wf-a")
    repo = _mock_repo(
        list_rows=[{"id": "wf-a", "definition": a_plain}, {"id": "wf-b", "definition": b_def}],
        get_row={"id": "wf-a", "name": "A", "definition": a_plain, "metadata": {}},
    )

    app = _make_authed_workflow_app(repo)
    client = TestClient(app)

    response = client.put("/api/workflows/wf-a", json={"definition": _subworkflow_def("wf-a", template_id="wf-b")})

    assert response.status_code == 422, f"Got {response.status_code}: {response.text}"
    errors = response.json()["detail"]["errors"]
    assert any(e.startswith("依赖环:") for e in errors)
    repo.update.assert_not_called()


def test_update_name_only_skips_cycle_check():
    """A name-only update never runs the cycle check, even when a cycle exists."""
    a_cyclic = _subworkflow_def("wf-a", template_id="wf-b")
    b_def = _subworkflow_def("wf-b", template_id="wf-a")
    repo = _mock_repo(
        list_rows=[{"id": "wf-a", "definition": a_cyclic}, {"id": "wf-b", "definition": b_def}],
        get_row={"id": "wf-a", "name": "A", "definition": a_cyclic, "metadata": {}},
    )

    app = _make_authed_workflow_app(repo)
    client = TestClient(app)

    with patch.object(workflow_routes, "_check_workflow_dependency_cycles", new=AsyncMock()) as mock_check:
        response = client.put("/api/workflows/wf-a", json={"name": "Renamed"})

    assert response.status_code == 200, f"Got {response.status_code}: {response.text}"
    mock_check.assert_not_called()


# ── User-scope isolation ──────────────────────────────────────────────────────


def test_user_scope_isolation():
    """A cycle in user_a's definitions does not block user_b's unrelated save."""
    user_a = SimpleNamespace(
        id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        system_role="user",
    )
    user_b = SimpleNamespace(
        id="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        system_role="user",
    )

    a_cyclic = _subworkflow_def("wf-a", template_id="wf-b")
    b_def = _subworkflow_def("wf-b", template_id="wf-a")

    def _list_by_user(user_id: str) -> list[dict]:
        if user_id == str(user_a.id):
            return [{"id": "wf-a", "definition": a_cyclic}, {"id": "wf-b", "definition": b_def}]
        return []

    repo = _mock_repo()
    repo.list_by_user = AsyncMock(side_effect=_list_by_user)

    # user_b saves a definition referencing user_a's id "wf-a", which user_b
    # does not hold in their own repo → no edge → no cycle → success.
    app = _make_authed_workflow_app(repo, user_factory=lambda: user_b)
    client = TestClient(app)

    response = client.post("/api/workflows", json={"name": "B's WF", "definition": _subworkflow_def("wf-b2", template_id="wf-a")})

    assert response.status_code in (200, 201), f"Got {response.status_code}: {response.text}"
    repo.create.assert_called_once()


# ── Skills-storage fail-open ──────────────────────────────────────────────────


def test_skills_storage_failure_fail_open():
    """A skills-storage failure never 500s; a cycle-free workflow still saves."""
    repo = _mock_repo(list_rows=[])
    app = _make_authed_workflow_app(repo)
    client = TestClient(app)

    with patch("deerflow.skills.storage.get_or_new_skill_storage", side_effect=RuntimeError("boom")):
        response = client.post("/api/workflows", json={"name": "A", "definition": _plain_def("wf-a")})

    assert response.status_code in (200, 201), f"Got {response.status_code}: {response.text}"
    repo.create.assert_called_once()


def test_skills_storage_failure_still_detects_workflow_cycle():
    """With skills unavailable, workflow-only cycle detection still rejects → 422."""
    fixed_hex = "deadbeefdeadbeefdeadbeefdeadbeef"
    target_id = f"wf-{fixed_hex}"
    b_def = _subworkflow_def("wf-b", template_id=target_id)
    repo = _mock_repo(list_rows=[{"id": "wf-b", "definition": b_def}])

    app = _make_authed_workflow_app(repo)
    client = TestClient(app)

    with patch("deerflow.skills.storage.get_or_new_skill_storage", side_effect=RuntimeError("boom")):
        with patch("uuid.uuid4", return_value=uuid.UUID(fixed_hex)):
            response = client.post("/api/workflows", json={"name": "A", "definition": _subworkflow_def("wf-a", template_id="wf-b")})

    assert response.status_code == 422, f"Got {response.status_code}: {response.text}"
    errors = response.json()["detail"]["errors"]
    assert any(e.startswith("依赖环:") for e in errors)


# ── Capability-group cycle ────────────────────────────────────────────────────


def test_capability_group_cycle_returns_422():
    """A workflow referencing a capability group whose dependencies cycle → 422."""
    g1 = _make_skill("g1-name", skill_id="guid-g1", dependencies=(DependencySpec(guid="guid-g2", version="0.1.0"),))
    g2 = _make_skill("g2-name", skill_id="guid-g2", dependencies=(DependencySpec(guid="guid-g1", version="0.1.0"),))

    mock_storage = MagicMock()
    mock_storage.load_skills.return_value = [g1, g2]

    repo = _mock_repo(list_rows=[])
    app = _make_authed_workflow_app(repo)
    client = TestClient(app)

    definition = _capability_group_def("wf-cap", ["g1-name"])
    with patch("deerflow.skills.storage.get_or_new_skill_storage", return_value=mock_storage):
        response = client.post("/api/workflows", json={"name": "Cap", "definition": definition})

    assert response.status_code == 422, f"Got {response.status_code}: {response.text}"
    errors = response.json()["detail"]["errors"]
    assert any(e.startswith("依赖环:") for e in errors)
    assert any("skill:guid-g1" in e and "skill:guid-g2" in e for e in errors), f"Expected capability-group cycle; got {errors}"
    repo.create.assert_not_called()
