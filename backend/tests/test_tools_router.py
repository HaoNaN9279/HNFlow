from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.gateway.routers import tools as tools_router


@pytest.mark.asyncio
async def test_list_tools_returns_catalog(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tools_router, "_catalog", lambda: [{"id": "builtin:read_file", "name": "read_file"}])

    assert await tools_router.list_tools() == {"tools": [{"id": "builtin:read_file", "name": "read_file"}]}


@pytest.mark.asyncio
async def test_get_tool_returns_404_for_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tools_router, "_catalog", lambda: [{"id": "builtin:read_file", "name": "read_file"}])

    with pytest.raises(HTTPException) as exc_info:
        await tools_router.get_tool("builtin:missing")

    assert exc_info.value.status_code == 404
