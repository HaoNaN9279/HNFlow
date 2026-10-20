"""Read-only tool catalog for capability-group references."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException

from deerflow.runtime.user_context import get_effective_user_id
from deerflow.tools.registry import ToolRegistry, ToolResolutionError
from deerflow.workflow.tool_gateway import build_default_tool_gateway

router = APIRouter(prefix="/api/tools", tags=["tools"])


def _catalog() -> list[dict[str, object]]:
    gateway = build_default_tool_gateway(user_id=get_effective_user_id())
    return ToolRegistry(gateway).descriptors()


@router.get("", summary="List Tools")
async def list_tools() -> dict[str, object]:
    try:
        tools = await asyncio.to_thread(_catalog)
    except Exception as exc:  # noqa: BLE001 - API boundary
        raise HTTPException(status_code=500, detail=f"Failed to load tools: {exc}") from exc
    return {"tools": tools}


@router.get("/{tool_id:path}", summary="Get Tool")
async def get_tool(tool_id: str) -> dict[str, object]:
    try:
        tools = await asyncio.to_thread(_catalog)
    except ToolResolutionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - API boundary
        raise HTTPException(status_code=500, detail=f"Failed to load tools: {exc}") from exc
    for tool in tools:
        if tool.get("id") == tool_id:
            return tool
    raise HTTPException(status_code=404, detail=f"tool {tool_id!r} not found")
