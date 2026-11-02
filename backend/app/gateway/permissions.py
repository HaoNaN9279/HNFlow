"""Route permission decorators.

Single-user deployment: every route is permitted, so the decorator is a
pass-through. It is kept as a named factory (rather than stripped from the
routers) so the route declarations continue to document the resource/action
they act on and so a future authorization layer can re-attach without
touching ~40 call sites.
"""

import functools
import inspect
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any, TypeVar

_F = TypeVar("_F", bound=Callable[..., Any])


def _make_test_request_stub() -> SimpleNamespace:
    """Minimal Request stand-in for direct-call unit tests.

    Real requests always arrive through FastAPI, which supplies ``request``;
    this only covers tests that invoke a decorated handler without one.
    """
    return SimpleNamespace(
        _deerflow_test_bypass_auth=True,
        state=SimpleNamespace(),
        app=SimpleNamespace(state=SimpleNamespace()),
        headers={},
        cookies={},
        url=SimpleNamespace(path="/", netloc="localhost", scheme="http"),
    )


def require_permission(
    resource: str,
    action: str,
    *,
    owner_check: bool = False,
    require_existing: bool = False,
) -> Callable[[_F], _F]:
    """Return a decorator that permits the route unconditionally.

    ``resource``/``action``/``owner_check``/``require_existing`` are retained
    for documentation and future re-introduction; they have no runtime effect.
    """

    def decorator(func: _F) -> _F:
        signature = inspect.signature(func)
        if "request" not in signature.parameters:
            return func

        @functools.wraps(func)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            try:
                bound = signature.bind_partial(*args, **kwargs)
            except TypeError:
                bound = None
            if bound is not None and "request" not in bound.arguments:
                kwargs["request"] = _make_test_request_stub()
            return await func(*args, **kwargs)

        return wrapper  # type: ignore[return-value]

    return decorator


async def require_admin_user(request: Any, *, detail: str) -> None:
    """Permit the route unconditionally in the single-user deployment.

    Kept as an awaitable so admin-gated routes retain their call shape.
    """
    return None
