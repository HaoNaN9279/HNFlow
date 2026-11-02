"""Helpers for router-level tests that need a stubbed request identity.

Router-level unit tests construct **bare** FastAPI apps that include only one
router. The production gateway resolves the caller identity ahead of every
router; these helpers make that identity available in tests.

This module provides two surfaces:

1. :func:`make_authed_test_app` — wraps ``FastAPI()`` with a tiny
   ``BaseHTTPMiddleware`` that stamps a fake user on every request, plus a
   permissive ``thread_store`` mock on ``app.state``. Use from TestClient-based
   router tests.

2. :func:`call_unwrapped` — invokes the underlying function bypassing any
   decorator chain by walking ``__wrapped__``.
"""

from __future__ import annotations

from collections.abc import Callable
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

from fastapi import FastAPI, Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp


def _make_stub_user() -> SimpleNamespace:
    """A deterministic test user identity — fresh id per call."""
    return SimpleNamespace(id=str(uuid4()))


class _StubAuthMiddleware(BaseHTTPMiddleware):
    """Stamp a fake user onto every request."""

    def __init__(self, app: ASGIApp, user_factory: Callable[[], SimpleNamespace]) -> None:
        super().__init__(app)
        self._user_factory = user_factory

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        request.state.user = self._user_factory()
        return await call_next(request)


def make_authed_test_app(
    *,
    user_factory: Callable[[], SimpleNamespace] | None = None,
    owner_check_passes: bool = True,
) -> FastAPI:
    """Build a FastAPI test app with a stub identity + permissive thread_store.

    Args:
        user_factory: Override the default test user.
        owner_check_passes: When True (default), ``thread_store.check_access``
            returns True for every call.

    Returns:
        A ``FastAPI`` app with the stub middleware installed and
        ``app.state.thread_store`` set to a permissive mock. The
        caller is still responsible for ``app.include_router(...)``.
    """
    factory = user_factory or _make_stub_user
    app = FastAPI()
    app.add_middleware(_StubAuthMiddleware, user_factory=factory)

    repo = MagicMock()
    repo.check_access = AsyncMock(return_value=owner_check_passes)
    app.state.thread_store = repo

    return app


def call_unwrapped[*P, R](decorated: Callable[P, R], /, *args: P.args, **kwargs: P.kwargs) -> R:
    """Invoke the underlying function of a decorated route.

    ``functools.wraps`` sets ``__wrapped__`` on each layer; we walk all the way
    down to the original handler. The ``ParamSpec`` propagates the wrapped
    route's signature so call sites still get parameter checking.
    """
    fn: Callable = decorated
    while hasattr(fn, "__wrapped__"):
        fn = fn.__wrapped__  # type: ignore[attr-defined]
    return fn(*args, **kwargs)
