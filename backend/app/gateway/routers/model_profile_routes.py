"""User-managed model profiles (the AI-node -> profile -> LLM middle layer)."""

from __future__ import annotations

from collections import Counter
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from app.gateway.deps import get_config, get_model_profile_repo, get_optional_user_from_request, get_workflow_definition_repo
from app.gateway.permissions import require_permission
from deerflow.config.app_config import AppConfig
from deerflow.persistence.model_profiles import ModelProfileConflictError
from deerflow.workflow.model_profiles import collect_model_profile_ids

router = APIRouter(prefix="/api/model-profiles", tags=["model-profiles"])

_PROFILE_NAME_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"


class ModelProfileCreateRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=64, pattern=_PROFILE_NAME_PATTERN)
    display_name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=4000)
    target_model: str = Field(min_length=1, max_length=128)
    enabled: bool = True


class ModelProfileUpdateRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str | None = Field(default=None, min_length=1, max_length=64, pattern=_PROFILE_NAME_PATTERN)
    display_name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=4000)
    target_model: str | None = Field(default=None, min_length=1, max_length=128)
    enabled: bool | None = None


class ModelProfileTarget(BaseModel):
    available: bool
    model: str | None = None
    display_name: str | None = None
    supports_thinking: bool = False
    supports_reasoning_effort: bool = False


class ModelProfileResponse(BaseModel):
    id: str
    user_id: str
    name: str
    display_name: str
    description: str | None = None
    target_model: str
    target: ModelProfileTarget
    enabled: bool
    referenced_by: int = 0
    referenced_workflows: int = 0
    created_at: str | None = None
    updated_at: str | None = None


class ModelProfilesResponse(BaseModel):
    profiles: list[ModelProfileResponse]


async def _user(request: Request):
    user = await get_optional_user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    return user


def _target(config: AppConfig, target_model: str) -> ModelProfileTarget:
    model = config.get_model_config(target_model)
    if model is None:
        return ModelProfileTarget(available=False)
    return ModelProfileTarget(
        available=True,
        model=model.model,
        display_name=model.display_name,
        supports_thinking=model.supports_thinking,
        supports_reasoning_effort=model.supports_reasoning_effort,
    )


def _require_target(config: AppConfig, target_model: str) -> None:
    if config.get_model_config(target_model) is None:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown target model '{target_model}'. Add it under `models:` in config.yaml first.",
        )


async def _references(request: Request, user_id: str) -> tuple[Counter[str], Counter[str]]:
    """Count AI-node references and distinct workflows per profile id."""
    repo = get_workflow_definition_repo(request)
    rows = await repo.list_by_user(user_id)
    nodes: Counter[str] = Counter()
    workflows: Counter[str] = Counter()
    for row in rows:
        definition = row.get("definition") if isinstance(row, dict) else None
        ids = collect_model_profile_ids(definition)
        for profile_id in ids:
            workflows[profile_id] += 1
        # A profile may be referenced by several nodes in one workflow.
        stack: list[Any] = [definition]
        while stack:
            item = stack.pop()
            if isinstance(item, dict):
                raw = item.get("model_profile")
                if isinstance(raw, str) and raw:
                    nodes[raw] += 1
                stack.extend(item.values())
            elif isinstance(item, list):
                stack.extend(item)
    return nodes, workflows


def _response(row: dict[str, Any], config: AppConfig, node_refs: Counter[str], workflow_refs: Counter[str]) -> ModelProfileResponse:
    profile_id = str(row["id"])
    return ModelProfileResponse(
        id=profile_id,
        user_id=str(row["user_id"]),
        name=str(row["name"]),
        display_name=str(row["display_name"]),
        description=row.get("description"),
        target_model=str(row["target_model"]),
        target=_target(config, str(row["target_model"])),
        enabled=bool(row.get("enabled", True)),
        referenced_by=node_refs.get(profile_id, 0),
        referenced_workflows=workflow_refs.get(profile_id, 0),
        created_at=row.get("created_at"),
        updated_at=row.get("updated_at"),
    )


@router.get("", response_model=ModelProfilesResponse)
@require_permission("models", "read")
async def list_model_profiles(request: Request, config: AppConfig = Depends(get_config)):
    user = await _user(request)
    repo = get_model_profile_repo(request)
    rows = await repo.list_by_user(str(user.id))
    node_refs, workflow_refs = await _references(request, str(user.id))
    return ModelProfilesResponse(profiles=[_response(row, config, node_refs, workflow_refs) for row in rows])


@router.post("", response_model=ModelProfileResponse)
@require_permission("models", "write")
async def create_model_profile(request: Request, body: ModelProfileCreateRequest, config: AppConfig = Depends(get_config)):
    user = await _user(request)
    _require_target(config, body.target_model)
    repo = get_model_profile_repo(request)
    try:
        row = await repo.create(
            user_id=str(user.id),
            name=body.name,
            display_name=body.display_name or body.name,
            description=body.description,
            target_model=body.target_model,
            enabled=body.enabled,
        )
    except ModelProfileConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return _response(row, config, Counter(), Counter())


@router.get("/{profile_id}", response_model=ModelProfileResponse)
@require_permission("models", "read")
async def get_model_profile(profile_id: str, request: Request, config: AppConfig = Depends(get_config)):
    user = await _user(request)
    repo = get_model_profile_repo(request)
    row = await repo.get(profile_id, user_id=str(user.id))
    if row is None:
        raise HTTPException(status_code=404, detail="Model profile not found")
    node_refs, workflow_refs = await _references(request, str(user.id))
    return _response(row, config, node_refs, workflow_refs)


@router.put("/{profile_id}", response_model=ModelProfileResponse)
@require_permission("models", "write")
async def update_model_profile(profile_id: str, request: Request, body: ModelProfileUpdateRequest, config: AppConfig = Depends(get_config)):
    user = await _user(request)
    updates = body.model_dump(exclude_unset=True)
    for required_field in ("name", "target_model", "enabled"):
        if required_field in updates and updates[required_field] is None:
            raise HTTPException(status_code=422, detail=f"'{required_field}' cannot be null")
    if updates.get("target_model") is not None:
        _require_target(config, str(updates["target_model"]))
    # Explicit null display names would make the required column nullable in the
    # response; treat them as "leave unchanged" rather than writing a bad row.
    if "display_name" in updates and updates["display_name"] is None:
        updates.pop("display_name")
    repo = get_model_profile_repo(request)
    try:
        row = await repo.update(profile_id, user_id=str(user.id), updates=updates)
    except ModelProfileConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if row is None:
        raise HTTPException(status_code=404, detail="Model profile not found")
    node_refs, workflow_refs = await _references(request, str(user.id))
    return _response(row, config, node_refs, workflow_refs)


@router.delete("/{profile_id}")
@require_permission("models", "write")
async def delete_model_profile(profile_id: str, request: Request):
    user = await _user(request)
    repo = get_model_profile_repo(request)
    row = await repo.get(profile_id, user_id=str(user.id))
    if row is None:
        raise HTTPException(status_code=404, detail="Model profile not found")
    node_refs, workflow_refs = await _references(request, str(user.id))
    if node_refs.get(profile_id, 0) > 0:
        raise HTTPException(
            status_code=409,
            detail=f"Model profile is referenced by {workflow_refs.get(profile_id, 0)} workflow(s); disable it instead of deleting it.",
        )
    await repo.delete(profile_id, user_id=str(user.id))
    return {"id": profile_id, "deleted": True}
