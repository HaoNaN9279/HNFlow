"""Tests for runtime.user_context — contextvar three-state semantics.

These tests opt out of the autouse contextvar fixture (added in
commit 6) because they explicitly test the cases where the contextvar
is set or unset.
"""

from types import SimpleNamespace

import pytest

from deerflow.runtime.user_context import (
    DEFAULT_USER_ID,
    CurrentUser,
    get_current_user,
    get_effective_user_id,
    require_current_user,
    reset_current_user,
    resolve_config_user_id,
    resolve_runtime_user_id,
    set_current_user,
)


@pytest.mark.no_auto_user
def test_default_is_none():
    """Before any set, contextvar returns None."""
    assert get_current_user() is None


@pytest.mark.no_auto_user
def test_set_and_reset_roundtrip():
    """set_current_user returns a token that reset restores."""
    user = SimpleNamespace(id="user-1")
    token = set_current_user(user)
    try:
        assert get_current_user() is user
    finally:
        reset_current_user(token)
    assert get_current_user() is None


@pytest.mark.no_auto_user
def test_require_current_user_raises_when_unset():
    """require_current_user raises RuntimeError if contextvar is unset."""
    assert get_current_user() is None
    with pytest.raises(RuntimeError, match="without user context"):
        require_current_user()


@pytest.mark.no_auto_user
def test_require_current_user_returns_user_when_set():
    """require_current_user returns the user when contextvar is set."""
    user = SimpleNamespace(id="user-2")
    token = set_current_user(user)
    try:
        assert require_current_user() is user
    finally:
        reset_current_user(token)


@pytest.mark.no_auto_user
def test_protocol_accepts_duck_typed():
    """CurrentUser is a runtime_checkable Protocol matching any .id-bearing object."""
    user = SimpleNamespace(id="user-3")
    assert isinstance(user, CurrentUser)


@pytest.mark.no_auto_user
def test_protocol_rejects_no_id():
    """Objects without .id do not satisfy CurrentUser Protocol."""
    not_a_user = SimpleNamespace(email="no-id@example.com")
    assert not isinstance(not_a_user, CurrentUser)


# ---------------------------------------------------------------------------
# get_effective_user_id / DEFAULT_USER_ID tests
# ---------------------------------------------------------------------------


def test_default_user_id_is_default():
    assert DEFAULT_USER_ID == "default"


@pytest.mark.no_auto_user
def test_effective_user_id_returns_default_when_no_user():
    """No user in context -> fallback to DEFAULT_USER_ID."""
    assert get_effective_user_id() == "default"


@pytest.mark.no_auto_user
def test_effective_user_id_returns_user_id_when_set():
    user = SimpleNamespace(id="u-abc-123")
    token = set_current_user(user)
    try:
        assert get_effective_user_id() == "u-abc-123"
    finally:
        reset_current_user(token)


@pytest.mark.no_auto_user
def test_effective_user_id_coerces_to_str():
    """User.id might be a UUID object; must come back as str."""
    import uuid

    uid = uuid.uuid4()

    user = SimpleNamespace(id=uid)
    token = set_current_user(user)
    try:
        assert get_effective_user_id() == str(uid)
    finally:
        reset_current_user(token)


# ---------------------------------------------------------------------------
# resolve_runtime_user_id tests


@pytest.mark.no_auto_user
def test_config_user_id_uses_gateway_runtime_context():
    config = {
        "configurable": {
            "user_id": "legacy-configurable-user",
        },
        "context": {
            "user_id": "gateway-user",
        },
    }

    assert resolve_config_user_id(config) == "gateway-user"


@pytest.mark.no_auto_user
def test_config_user_id_falls_back_to_legacy_configurable_user():
    assert resolve_config_user_id({"configurable": {"user_id": "legacy-user"}}) == "legacy-user"


@pytest.mark.no_auto_user
def test_runtime_user_id_uses_runtime_context():
    runtime = SimpleNamespace(context={"user_id": "runtime-user"})

    assert resolve_runtime_user_id(runtime) == "runtime-user"


@pytest.mark.no_auto_user
def test_runtime_user_id_falls_back_to_contextvar():
    token = set_current_user(SimpleNamespace(id="context-user"))
    try:
        assert resolve_runtime_user_id(None) == "context-user"
    finally:
        reset_current_user(token)


@pytest.mark.no_auto_user
def test_runtime_user_id_falls_back_to_default_without_context():
    assert resolve_runtime_user_id(None) == DEFAULT_USER_ID
