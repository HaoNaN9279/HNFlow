"""Router tests for human task CRUD endpoints."""

from __future__ import annotations

from collections.abc import Callable
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from fastapi import FastAPI, Request, Response
from fastapi.testclient import TestClient
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

from app.gateway.routers import human_task_routes

# ── Fixtures ─────────────────────────────────────────────────────────────────

_STUB_USER_ID = "default"


def _make_stub_user() -> SimpleNamespace:
    return SimpleNamespace(
        id=_STUB_USER_ID,
        system_role="user",
    )


class _HumanTaskTestAuthMiddleware(BaseHTTPMiddleware):
    """Stamp a fake user onto every request."""

    def __init__(self, app: ASGIApp, user_factory: Callable[[], SimpleNamespace]) -> None:
        super().__init__(app)
        self._user_factory = user_factory

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        request.state.user = self._user_factory()
        return await call_next(request)


def _make_authed_app(repo) -> FastAPI:
    """Build a FastAPI test app with stub auth + human task repo on app.state."""
    app = FastAPI()
    app.add_middleware(_HumanTaskTestAuthMiddleware, user_factory=_make_stub_user)
    app.state.human_task_repo = repo
    app.include_router(human_task_routes.router)
    return app


def _make_task(status: str = "pending", output_spec: dict | None = None, validation_rules: dict | None = None) -> dict:
    return {
        "id": "ht-abc",
        "user_id": _STUB_USER_ID,
        "status": status,
        "output_spec": output_spec,
        "validation_rules": validation_rules,
        "submission": None,
    }


_BOOL_SPEC = {"ports": [{"name": "approval", "type": "bool", "required": True}]}


# ── GET / ─────────────────────────────────────────────────────────────────────


def test_list_success_passes_user_id_to_repo():
    mock_repo = MagicMock()
    mock_repo.list_by_user = AsyncMock(return_value=[{"id": "ht-1", "status": "pending"}])
    app = _make_authed_app(mock_repo)
    client = TestClient(app)

    response = client.get("/api/human-tasks")
    assert response.status_code == 200
    assert response.json() == [{"id": "ht-1", "status": "pending"}]
    mock_repo.list_by_user.assert_awaited_once_with(_STUB_USER_ID, status=None, kind=None)


def test_list_invalid_status_returns_422():
    mock_repo = MagicMock()
    mock_repo.list_by_user = AsyncMock(return_value=[])
    app = _make_authed_app(mock_repo)
    client = TestClient(app)

    response = client.get("/api/human-tasks", params={"status": "bogus"})
    assert response.status_code == 422
    assert response.json()["detail"]["errors"] == ["无效的 status 过滤值: bogus"]
    mock_repo.list_by_user.assert_not_called()


def test_list_valid_status_is_passed_through():
    mock_repo = MagicMock()
    mock_repo.list_by_user = AsyncMock(return_value=[])
    app = _make_authed_app(mock_repo)
    client = TestClient(app)

    response = client.get("/api/human-tasks", params={"status": "pending"})
    assert response.status_code == 200
    mock_repo.list_by_user.assert_awaited_once_with(_STUB_USER_ID, status="pending", kind=None)


# ── POST /{task_id}/submit ────────────────────────────────────────────────────


def test_submit_task_not_found_returns_404():
    mock_repo = MagicMock()
    mock_repo.get = AsyncMock(return_value=None)
    app = _make_authed_app(mock_repo)
    client = TestClient(app)

    response = client.post("/api/human-tasks/ht-missing/submit", json={"values": {}})
    assert response.status_code == 404
    assert response.json()["detail"] == "Human task not found"
    mock_repo.get.assert_awaited_once_with("ht-missing", user_id=_STUB_USER_ID)


def test_submit_validation_failure_returns_422_and_reopens():
    mock_repo = MagicMock()
    mock_repo.get = AsyncMock(return_value=_make_task(output_spec=_BOOL_SPEC))
    mock_repo.submit = AsyncMock(return_value={"id": "ht-abc", "status": "reopened"})
    app = _make_authed_app(mock_repo)
    client = TestClient(app)

    response = client.post("/api/human-tasks/ht-abc/submit", json={"values": {}})
    assert response.status_code == 422
    assert "errors" in response.json()["detail"]
    # Failed values are preserved and the task is moved back to reopened.
    mock_repo.submit.assert_awaited_once_with("ht-abc", user_id=_STUB_USER_ID, values={}, to_status="reopened")


def test_submit_validation_success_returns_200_and_submits():
    mock_repo = MagicMock()
    mock_repo.get = AsyncMock(return_value=_make_task(output_spec=_BOOL_SPEC))
    mock_repo.submit = AsyncMock(return_value={"id": "ht-abc", "status": "submitted", "submission": {"approval": True}})
    app = _make_authed_app(mock_repo)
    client = TestClient(app)

    response = client.post("/api/human-tasks/ht-abc/submit", json={"values": {"approval": True}})
    assert response.status_code == 200
    assert response.json()["status"] == "submitted"
    mock_repo.submit.assert_awaited_once_with("ht-abc", user_id=_STUB_USER_ID, values={"approval": True}, to_status="submitted")


def test_submit_validation_success_but_conflict_returns_409():
    mock_repo = MagicMock()
    mock_repo.get = AsyncMock(return_value=_make_task(output_spec=_BOOL_SPEC))
    mock_repo.submit = AsyncMock(return_value=None)
    app = _make_authed_app(mock_repo)
    client = TestClient(app)

    response = client.post("/api/human-tasks/ht-abc/submit", json={"values": {"approval": True}})
    assert response.status_code == 409
    assert response.json()["detail"]["errors"] == ["任务当前状态不允许提交"]


# ── POST /{task_id}/skip ──────────────────────────────────────────────────────


def test_skip_success_returns_200():
    mock_repo = MagicMock()
    mock_repo.get = AsyncMock(return_value=_make_task())
    mock_repo.skip = AsyncMock(return_value={"id": "ht-abc", "status": "skipped"})
    app = _make_authed_app(mock_repo)
    client = TestClient(app)

    response = client.post("/api/human-tasks/ht-abc/skip")
    assert response.status_code == 200
    assert response.json()["status"] == "skipped"
    mock_repo.skip.assert_awaited_once_with("ht-abc", user_id=_STUB_USER_ID)


def test_skip_conflict_returns_409():
    mock_repo = MagicMock()
    mock_repo.get = AsyncMock(return_value=_make_task())
    mock_repo.skip = AsyncMock(return_value=None)
    app = _make_authed_app(mock_repo)
    client = TestClient(app)

    response = client.post("/api/human-tasks/ht-abc/skip")
    assert response.status_code == 409
    assert "errors" in response.json()["detail"]


# ── POST /{task_id}/reopen ────────────────────────────────────────────────────


def test_reopen_success_returns_200():
    mock_repo = MagicMock()
    mock_repo.get = AsyncMock(return_value=_make_task(status="submitted"))
    mock_repo.reopen = AsyncMock(return_value={"id": "ht-abc", "status": "reopened"})
    app = _make_authed_app(mock_repo)
    client = TestClient(app)

    response = client.post("/api/human-tasks/ht-abc/reopen")
    assert response.status_code == 200
    assert response.json()["status"] == "reopened"
    mock_repo.reopen.assert_awaited_once_with("ht-abc", user_id=_STUB_USER_ID)


def test_reopen_conflict_returns_409():
    mock_repo = MagicMock()
    mock_repo.get = AsyncMock(return_value=_make_task(status="submitted"))
    mock_repo.reopen = AsyncMock(return_value=None)
    app = _make_authed_app(mock_repo)
    client = TestClient(app)

    response = client.post("/api/human-tasks/ht-abc/reopen")
    assert response.status_code == 409
    assert "errors" in response.json()["detail"]


# ── 503（repo 缺失） ──────────────────────────────────────────────────────────


def test_missing_repo_returns_503():
    app = FastAPI()
    app.add_middleware(_HumanTaskTestAuthMiddleware, user_factory=_make_stub_user)
    # Deliberately do NOT set app.state.human_task_repo
    app.include_router(human_task_routes.router)
    client = TestClient(app)

    for method, url, body in [
        ("get", "/api/human-tasks", None),
        ("post", "/api/human-tasks/ht-abc/submit", {"values": {}}),
        ("post", "/api/human-tasks/ht-abc/skip", None),
        ("post", "/api/human-tasks/ht-abc/reopen", None),
    ]:
        if method == "get":
            resp = client.get(url)
        else:
            resp = client.post(url, json=body)
        assert resp.status_code == 503, f"{method.upper()} {url} returned {resp.status_code}, expected 503"
