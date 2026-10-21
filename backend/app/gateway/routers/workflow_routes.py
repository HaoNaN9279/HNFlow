"""Workflow definition CRUD routes.

REST endpoints for creating, listing, reading, updating, and deleting
workflow definitions.  Every definition is user-scoped and structurally
validated against the ``WorkflowDefinition`` schema before persistence.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError

from app.gateway.deps import get_optional_user_from_request, get_workflow_definition_repo, get_workflow_folder_repo
from app.gateway.permissions import require_permission
from deerflow.workflow.compiler import WorkflowCompileError, compile_definition
from deerflow.workflow.definition_evals import DefinitionEvalError, definition_has_evals, eval_gate_errors, evaluate_definition_evals, parse_definition_evals
from deerflow.workflow.dependency_graph import find_dependency_cycles
from deerflow.workflow.executors import build_default_registry
from deerflow.workflow.model_profiles import collect_model_profile_ids, model_names
from deerflow.workflow.prompt_preview import PromptPreviewError, build_prompt_preview
from deerflow.workflow.runtime_context import build_workflow_compile_context
from deerflow.workflow.schema import WorkflowDefinition
from deerflow.workflow.workflow_io import SCHEMA_VERSION, validate_definition

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["workflows"])


# 鈹€鈹€ Request / Response models 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€


class WorkflowCreateRequest(BaseModel):
    name: str = Field(min_length=1)
    definition: dict[str, Any]
    metadata: dict[str, Any] = Field(default_factory=dict)
    version: str = "0.1.0"
    folder_id: str | None = None


class WorkflowUpdateRequest(BaseModel):
    name: str | None = None
    definition: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None
    version: str | None = None
    folder_id: str | None = None


class WorkflowPromptPreviewRequest(BaseModel):
    node_id: str
    # The canvas sends its current (possibly unsaved) definition so the preview
    # matches what the author is looking at.  Omitted means "use the saved one".
    definition: dict[str, Any] | None = None


async def _run_embedded_eval_gate(model: WorkflowDefinition) -> None:
    """Run the definition's embedded eval suite when it opts in (N14 搂24.8).

    Only a definition whose ``metadata.evals.require_pass`` is true is gated 鈥?    a suite that merely *documents* expectations never blocks a save. A
    malformed spec or a failing required suite rejects the request with 422
    and the per-assertion failures, so a regression cannot be persisted
    silently.
    """
    try:
        parsed = parse_definition_evals(model.metadata)
    except DefinitionEvalError as exc:
        raise HTTPException(status_code=422, detail={"errors": [f"鍐呭祵璇勬祴瑙勬牸闈炴硶: {exc}"]}) from exc
    if parsed is None or not parsed.require_pass:
        return

    try:
        report = await evaluate_definition_evals(model)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 鈥?a suite that cannot run must not look like a pass
        logger.warning("Embedded eval gate could not run: %s", exc, exc_info=True)
        raise HTTPException(status_code=422, detail={"errors": [f"鍐呭祵璇勬祴鏃犳硶鎵ц: {type(exc).__name__}: {exc}"]}) from exc

    if report is not None and report.failed:
        raise HTTPException(status_code=422, detail={"errors": eval_gate_errors(report)})


# 鈹€鈹€ Helpers 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€


async def _validate_semantics(request: Request, definition: WorkflowDefinition, user: Any) -> None:
    """Dry-run compile so semantic errors fail the save, not a later run.

    Structural validation only checks graph shape.  Review/retry/loop/context/
    output-schema rules live in the compiler; running it here (without executing
    nodes) turns "saved successfully, failed at run" into a node-level 422.
    """
    from app.gateway.services import _build_workflow_template_resolver
    from deerflow.workflow.schema import validate_capability_tool_refs

    tool_errors = validate_capability_tool_refs(definition, user_id=str(user.id))
    if tool_errors:
        raise HTTPException(status_code=422, detail={"errors": tool_errors})

    resolver = await _build_workflow_template_resolver(definition, request, user_id=str(user.id))
    profiles: dict[str, Any] = {}
    available_models: frozenset[str] = frozenset()
    if collect_model_profile_ids(definition.model_dump(mode="json")):
        repo = getattr(request.app.state, "model_profile_repo", None)
        if repo is not None:
            profiles = {str(row["id"]): row for row in await repo.list_by_user(str(user.id))}
    from deerflow.config import get_app_config

    app_config = get_app_config()
    available_models = model_names(app_config.models)
    model_context_windows = {str(model.name): int(model.context_window) for model in app_config.models if getattr(model, "context_window", None) is not None}
    ctx = build_workflow_compile_context(
        build_default_registry(),
        checkpointer=None,
        definition_resolver=resolver,
        model_profiles=profiles,
        available_model_names=available_models,
        model_context_windows=model_context_windows,
        default_model_name=str(app_config.models[0].name) if app_config.models else None,
    )
    try:
        compile_definition(definition, context=ctx)
    except WorkflowCompileError as exc:
        message = str(exc)
        # A dangling template reference is intentionally allowed at save time
        # (the template may be installed later); compile still reports it at
        # run time.  Do not turn the save into a stricter contract here.
        if "subworkflow template" in message and "not found" in message:
            logger.warning("Definition %s references an unavailable template; semantic dry-run skipped: %s", definition.id, message)
            return
        raise HTTPException(status_code=422, detail={"errors": [f"瀹氫箟璇箟鏍￠獙澶辫触: {message}"]}) from exc


def _resolve_workflow_metadata(definition: WorkflowDefinition, metadata: dict[str, Any]) -> dict[str, Any]:
    """Populate ``metadata["resolved_groups"]`` and freeze the lockfile snapshot.

    ``resolved_groups`` is resolved from the definition's capability groups when
    any node declares them; otherwise it is left as provided.  Either way a
    fresh ``metadata["lockfile"]`` capability snapshot (搂5.6) is attached so the
    saved definition records its reproducibility inputs.  Fail-open: a
    capability-group discovery or config-read failure never rejects the save —
    it degrades to the best snapshot available (mirrors the harness-layer save
    service).
    """
    from deerflow.persistence.workflow_definitions.service import _resolve_workflow_metadata as resolve_metadata

    # The harness owns capability resolution + lockfile construction; the
    # Gateway only supplies caller metadata.  Keeping one implementation stops
    # the two save paths (HTTP vs. chat tool) from drifting.
    return resolve_metadata(definition, metadata)


async def _check_workflow_dependency_cycles(
    request: Request,
    repo: Any,
    user_id: str,
    target_id: str,
    target_def: WorkflowDefinition,
) -> list[str]:
    """Detect dependency cycles across the user's workflows and capability groups.

    Builds a definition map keyed by DB id from every stored workflow, then
    overlays *target_def* under *target_id* so the to-be-saved definition
    replaces the stored one (update) or joins as a new node (create).  A single
    unparseable stored row is skipped rather than aborting the whole check.

    Capability-group edges are intentionally not part of cycle detection here:
    the group registry is being rewritten, so this check only covers workflow →
    subworkflow references.
    """
    rows = await repo.list_by_user(user_id)
    definitions: dict[str, WorkflowDefinition] = {}
    for row in rows:
        row_id = row.get("id") if isinstance(row, dict) else getattr(row, "id", None)
        if not row_id:
            continue
        definition_dict = row.get("definition") if isinstance(row, dict) else getattr(row, "definition", None)
        if definition_dict is None:
            continue
        try:
            definitions[row_id] = WorkflowDefinition.model_validate(definition_dict)
        except Exception:
            continue
    definitions[target_id] = target_def

    return find_dependency_cycles(definitions, ())


async def _validate_folder(request: Request, folder_id: str | None, user: Any) -> None:
    if folder_id is None:
        return
    repo = get_workflow_folder_repo(request)
    folder = await repo.get(folder_id, user_id=str(user.id))
    if folder is None:
        raise HTTPException(status_code=404, detail="Workflow folder not found")


def _format_validation_errors(exc: ValidationError) -> list[str]:
    """Convert a Pydantic v2 ValidationError into a list of human-readable strings."""
    return [f"瀹氫箟缁撴瀯闈炴硶: {'.'.join(str(loc) for loc in e['loc'])} 鈥?{e['msg']}" for e in exc.errors(include_url=False)]


# 鈹€鈹€ Routes 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€


@router.get("/workflows")
@require_permission("threads", "read")
async def list_workflows(request: Request):
    user = await get_optional_user_from_request(request)
    if user is None:
        return []
    repo = get_workflow_definition_repo(request)
    return await repo.list_by_user(str(user.id))


@router.get("/workflows/templates")
async def list_workflow_templates():
    """List the built-in collaboration templates the canvas can insert (N14 搂24.6b).

    Declared before ``/workflows/{definition_id}`` so the literal path is matched
    first. Returns each template's name/description plus its serialized
    ``WorkflowDefinition`` skeleton (valid, compilable; instructions are
    placeholders for the author to fill in).
    """
    from deerflow.workflow.patterns import build_template, template_catalog
    from deerflow.workflow.workflow_io import serialize

    return [{"name": entry["name"], "description": entry["description"], "definition": serialize(build_template(entry["name"]))} for entry in template_catalog()]


@router.post("/workflows")
@require_permission("threads", "write")
async def create_workflow(request: Request, body: WorkflowCreateRequest):
    user = await get_optional_user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")

    # Structural validation 鈥?must be a valid WorkflowDefinition
    try:
        model = WorkflowDefinition.model_validate(body.definition)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail={"errors": _format_validation_errors(exc)}) from exc

    # Graph-structure validation 鈥?cycles, start/end, edge refs, port types, params
    errors = validate_definition(model)
    if errors:
        raise HTTPException(status_code=422, detail={"errors": errors})
    await _validate_folder(request, body.folder_id, user)
    await _validate_semantics(request, model, user)

    # N14 搂24.8: opt-in embedded eval gate (no-op unless require_pass is set).
    await _run_embedded_eval_gate(model)

    repo = get_workflow_definition_repo(request)
    target_id = f"wf-{uuid.uuid4().hex}"
    cycle_errors = await _check_workflow_dependency_cycles(request, repo, str(user.id), target_id, model)
    if cycle_errors:
        raise HTTPException(status_code=422, detail={"errors": [f"依赖环: {e}" for e in cycle_errors]})
    metadata = _resolve_workflow_metadata(model, body.metadata)
    result = await repo.create(
        definition_id=target_id,
        user_id=str(user.id),
        name=body.name,
        schema_version=SCHEMA_VERSION,
        definition=model.model_dump(mode="json"),
        metadata=metadata,
        version=body.version,
        folder_id=body.folder_id,
    )
    return result


@router.get("/workflows/{definition_id}")
@require_permission("threads", "read")
async def get_workflow(definition_id: str, request: Request):
    user = await get_optional_user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    repo = get_workflow_definition_repo(request)
    result = await repo.get(definition_id, user_id=str(user.id))
    if result is None:
        raise HTTPException(status_code=404, detail="Workflow definition not found")
    return result


@router.post("/workflows/{definition_id}/evaluate")
@require_permission("threads", "read")
async def evaluate_workflow(definition_id: str, request: Request):
    """N14 搂24.8: replay this definition's embedded eval suite on demand.

    Reads the saved definition, replays its own golden fixture (deterministic,
    no model/tool call) and returns the report. A definition without an
    embedded suite answers ``ran: false`` with 200 鈥?not having evals is a
    normal state, not an error. A malformed spec is 422 (it would otherwise
    silently disable the gate).
    """
    user = await get_optional_user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")

    repo = get_workflow_definition_repo(request)
    record = await repo.get(definition_id, user_id=str(user.id))
    if record is None:
        raise HTTPException(status_code=404, detail="Workflow definition not found")

    raw_definition = record.get("definition") if isinstance(record, dict) else getattr(record, "definition", None)
    try:
        model = WorkflowDefinition.model_validate(raw_definition)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail={"errors": _format_validation_errors(exc)}) from exc

    try:
        parsed = parse_definition_evals(model.metadata)
    except DefinitionEvalError as exc:
        raise HTTPException(status_code=422, detail={"errors": [f"鍐呭祵璇勬祴瑙勬牸闈炴硶: {exc}"]}) from exc

    if not definition_has_evals(model):
        return {"definition_id": definition_id, "ran": False, "require_pass": False, "passed": None, "report": None, "errors": []}

    try:
        report = await evaluate_definition_evals(model)
    except Exception as exc:  # noqa: BLE001 鈥?surface a runnable failure as a 422 with the cause
        logger.warning("Embedded eval suite for %s could not run: %s", definition_id, exc, exc_info=True)
        raise HTTPException(status_code=422, detail={"errors": [f"鍐呭祵璇勬祴鏃犳硶鎵ц: {type(exc).__name__}: {exc}"]}) from exc

    return {
        "definition_id": definition_id,
        "ran": True,
        "require_pass": bool(parsed.require_pass) if parsed else False,
        "passed": bool(report.passed and not report.failed) if report else None,
        "report": report.to_dict() if report else None,
        "errors": eval_gate_errors(report) if report else [],
    }


@router.post("/workflows/{definition_id}/prompt-preview")
@require_permission("threads", "read")
async def preview_workflow_prompt(definition_id: str, request: Request, body: WorkflowPromptPreviewRequest):
    """Assemble an AI node's text prompt without running the model.

    The canvas may send its current definition; otherwise the saved definition
    is used.  Runtime-only memory/retrieval blocks are reported as omitted by
    the response rather than fabricated.
    """
    user = await get_optional_user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")

    if body.definition is not None:
        raw_definition: Any = body.definition
    else:
        repo = get_workflow_definition_repo(request)
        record = await repo.get(definition_id, user_id=str(user.id))
        if record is None:
            raise HTTPException(status_code=404, detail="Workflow definition not found")
        raw_definition = record.get("definition") if isinstance(record, dict) else getattr(record, "definition", None)

    try:
        model = WorkflowDefinition.model_validate(raw_definition)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail={"errors": _format_validation_errors(exc)}) from exc

    errors = validate_definition(model)
    if errors:
        raise HTTPException(status_code=422, detail={"errors": errors})

    try:
        preview = await asyncio.to_thread(build_prompt_preview, model, body.node_id, user_id=str(user.id))
    except PromptPreviewError as exc:
        raise HTTPException(status_code=422, detail={"errors": [str(exc)]}) from exc
    return preview.to_dict()


@router.put("/workflows/{definition_id}")
@require_permission("threads", "write")
async def update_workflow(definition_id: str, request: Request, body: WorkflowUpdateRequest):
    user = await get_optional_user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")

    repo = get_workflow_definition_repo(request)

    # Verify the definition exists
    existing = await repo.get(definition_id, user_id=str(user.id))
    if existing is None:
        raise HTTPException(status_code=404, detail="Workflow definition not found")

    updates: dict[str, Any] = {}

    if "folder_id" in body.model_fields_set:
        await _validate_folder(request, body.folder_id, user)
        updates["folder_id"] = body.folder_id

    if body.definition is not None:
        try:
            model = WorkflowDefinition.model_validate(body.definition)
        except ValidationError as exc:
            raise HTTPException(status_code=422, detail={"errors": _format_validation_errors(exc)}) from exc

        errors = validate_definition(model)
        if errors:
            raise HTTPException(status_code=422, detail={"errors": errors})
        await _validate_semantics(request, model, user)

        # N14 搂24.8: opt-in embedded eval gate (no-op unless require_pass is set).
        await _run_embedded_eval_gate(model)

        cycle_errors = await _check_workflow_dependency_cycles(request, repo, str(user.id), definition_id, model)
        if cycle_errors:
            raise HTTPException(status_code=422, detail={"errors": [f"依赖环: {e}" for e in cycle_errors]})

        updates["definition"] = model.model_dump(mode="json")
        updates["schema_version"] = SCHEMA_VERSION
        # Re-resolve capability groups when the definition changes.
        # If the user also sent metadata, use it as base; otherwise
        # carry forward the existing metadata so keys like resolved_groups
        # can be rebuilt from the definition without wiping user fields.
        base_meta = body.metadata if body.metadata is not None else existing.get("metadata") or {}
        updates["metadata"] = _resolve_workflow_metadata(model, base_meta)

    if body.name is not None:
        updates["name"] = body.name

    if body.metadata is not None:
        # If definition was updated above, metadata has already been resolved.
        # Otherwise pass the user-supplied metadata through as-is (no auto-injection).
        if "metadata" not in updates:
            updates["metadata"] = body.metadata

    if body.version is not None:
        updates["version"] = body.version

    if not updates:
        # Nothing to update 鈥?return the existing definition
        return existing

    result = await repo.update(definition_id, user_id=str(user.id), updates=updates)
    if result is None:
        raise HTTPException(status_code=404, detail="Workflow definition not found")
    return result


@router.delete("/workflows/{definition_id}")
@require_permission("threads", "write")
async def delete_workflow(definition_id: str, request: Request):
    user = await get_optional_user_from_request(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    repo = get_workflow_definition_repo(request)
    deleted = await repo.delete(definition_id, user_id=str(user.id))
    if not deleted:
        raise HTTPException(status_code=404, detail="Workflow definition not found")
    # Workbench membership is only a reference; remove dangling rows without
    # touching the workbench itself or any historical run.
    workbench_repo = getattr(request.app.state, "workflow_workbench_repo", None)
    if workbench_repo is not None:
        try:
            await workbench_repo.delete_memberships_for_definition(definition_id)
        except Exception:
            logger.warning("Failed to remove workbench memberships for deleted workflow %s", definition_id, exc_info=True)
    return {"id": definition_id, "deleted": True}
