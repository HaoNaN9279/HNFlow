"""Formal specification CRUD, immutable revisions, freeze and lint."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from app.gateway.deps import get_optional_user_from_request, get_spec_repo
from deerflow.persistence.specifications import SpecificationConflictError, SpecificationNotFoundError
from deerflow.workflow.spec import SpecLanguage
from deerflow.workflow.verifiers.spec_lint import lint_spec_content

router = APIRouter(prefix="/api/specifications", tags=["specifications"])

_NAME_PATTERN = r"^[^\x00-\x1f]{1,255}$"


class SpecificationCreateRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=255, pattern=_NAME_PATTERN)
    language: SpecLanguage
    content: str = Field(min_length=1)
    title: str | None = Field(default=None, max_length=255)
    metadata: dict[str, Any] = Field(default_factory=dict)


class SpecificationRevisionRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    content: str = Field(min_length=1)
    title: str | None = Field(default=None, max_length=255)
    metadata: dict[str, Any] = Field(default_factory=dict)
    language: SpecLanguage | None = None


class SpecificationFreezeRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    approved_by: str = Field(min_length=1, max_length=64)
    approval_task_id: str | None = Field(default=None, max_length=64)


class SpecificationLintRequest(BaseModel):
    revision: int | None = Field(default=None, ge=1)


async def _user(request: Request):
    user = await get_optional_user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    return user


@router.get("")
async def list_specifications(request: Request, repo=Depends(get_spec_repo)):
    user = await _user(request)
    return {"specifications": await repo.list_by_user(str(user.id))}


@router.post("", status_code=201)
async def create_specification(body: SpecificationCreateRequest, request: Request, repo=Depends(get_spec_repo)):
    user = await _user(request)
    row = await repo.create(
        user_id=str(user.id),
        name=body.name,
        language=body.language,
        content=body.content,
        title=body.title,
        metadata=body.metadata,
    )
    return _revision_payload(row)


@router.get("/{spec_id}")
async def get_specification(spec_id: str, request: Request, repo=Depends(get_spec_repo)):
    user = await _user(request)
    row = await repo.get(spec_id, user_id=str(user.id))
    if row is None:
        raise HTTPException(status_code=404, detail="Specification not found")
    return row


@router.get("/{spec_id}/revisions")
async def list_revisions(spec_id: str, request: Request, repo=Depends(get_spec_repo)):
    user = await _user(request)
    try:
        rows = await repo.list_revisions(spec_id, user_id=str(user.id))
    except SpecificationNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Specification not found") from exc
    return {"revisions": [_revision_payload(row) for row in rows]}


@router.post("/{spec_id}/revisions", status_code=201)
async def create_revision(spec_id: str, body: SpecificationRevisionRequest, request: Request, repo=Depends(get_spec_repo)):
    user = await _user(request)
    try:
        row = await repo.add_revision(
            spec_id,
            user_id=str(user.id),
            content=body.content,
            title=body.title,
            metadata=body.metadata,
            language=body.language,
        )
    except SpecificationNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Specification not found") from exc
    return _revision_payload(row)


@router.get("/{spec_id}/revisions/{revision}")
async def get_revision(spec_id: str, revision: int, request: Request, repo=Depends(get_spec_repo)):
    user = await _user(request)
    row = await repo.get_revision(spec_id, revision, user_id=str(user.id))
    if row is None:
        raise HTTPException(status_code=404, detail="Specification revision not found")
    return _revision_payload(row)


@router.post("/{spec_id}/revisions/{revision}/freeze")
async def freeze_revision(spec_id: str, revision: int, body: SpecificationFreezeRequest, request: Request, repo=Depends(get_spec_repo)):
    user = await _user(request)
    try:
        row = await repo.freeze(
            spec_id,
            revision,
            user_id=str(user.id),
            approved_by=body.approved_by,
            approval_task_id=body.approval_task_id,
        )
    except SpecificationNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Specification revision not found") from exc
    except SpecificationConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return _revision_payload(row)


@router.post("/{spec_id}/lint")
async def lint_specification(spec_id: str, body: SpecificationLintRequest, request: Request, repo=Depends(get_spec_repo)):
    user = await _user(request)
    head = await repo.get(spec_id, user_id=str(user.id))
    if head is None:
        raise HTTPException(status_code=404, detail="Specification not found")
    revision = body.revision or int(head["current_revision"])
    row = await repo.get_revision(spec_id, revision, user_id=str(user.id))
    if row is None:
        raise HTTPException(status_code=404, detail="Specification revision not found")
    issues = lint_spec_content(SpecLanguage(row["language"]), str(row["content"]))
    return {"spec_id": spec_id, "revision": revision, "issues": [issue.model_dump(mode="json") for issue in issues]}


def _revision_payload(row: dict[str, Any]) -> dict[str, Any]:
    payload = dict(row)
    payload.setdefault("metadata", {})
    return payload
