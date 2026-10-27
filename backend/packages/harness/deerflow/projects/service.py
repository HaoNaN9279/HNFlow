"""Project and workbench service backed by files."""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from deerflow.capability_groups.vibestack import (
    VibeStackError,
    default_core,
    ensure_project_stack,
    read_project_stack,
    resolve_repository,
)
from deerflow.persistence.projects import ProjectRepository, ProjectRootConflictError
from deerflow.projects.capability_activation import activate_definition_groups, collect_definition_group_refs
from deerflow.projects.schema import ProjectManifest, WorkbenchFile, WorkbenchMember
from deerflow.projects.store import (
    ProjectFileError,
    create_project_files,
    delete_workbench_file,
    list_workbench_files,
    manifest_content_hash,
    read_manifest,
    read_workbench,
    resolve_project_root,
    write_workbench,
)
from deerflow.workflow.schema import WorkflowDefinition

logger = logging.getLogger(__name__)


def _stack_status(root: Path) -> dict[str, Any]:
    """Return a read-only description of the project's VibeStack stack."""
    repository = None
    repository_error = None
    try:
        repository = resolve_repository()
    except VibeStackError as exc:
        repository_error = str(exc)
    core = default_core()
    try:
        stack = read_project_stack(root)
    except VibeStackError as exc:
        return {
            "path": str(root / ".vibestack" / "stack.json"),
            "exists": True,
            "repository": str(repository) if repository else None,
            "repository_error": repository_error,
            "core": core.to_dict(),
            "groups": [],
            "active_groups": [str(core)],
            "error": str(exc),
        }
    if stack is None:
        return {
            "path": str(root / ".vibestack" / "stack.json"),
            "exists": False,
            "repository": str(repository) if repository else None,
            "repository_error": repository_error,
            "core": core.to_dict(),
            "groups": [],
            "active_groups": [str(core)],
            "error": None,
        }
    core_ref = stack.core or core
    active = [f"{core_ref.name}@{core_ref.version}" if core_ref.version else core_ref.name]
    active.extend(f"{group.name}@{group.version}" if group.version else group.name for group in stack.groups)
    return {
        "path": str(stack.path),
        "exists": True,
        "repository": str(repository) if repository else None,
        "repository_error": repository_error,
        "core": (stack.core or core).to_dict(),
        "groups": [group.to_dict() for group in stack.groups],
        "active_groups": active,
        "error": None,
    }


class ProjectError(ValueError):
    """Base error for the project/workbench service."""


class ProjectNotFoundError(ProjectError):
    """The project id is not registered or its files are missing."""


class ProjectConflictError(ProjectError):
    """A project id/root conflicts with an existing registration."""


class WorkbenchNotFoundError(ProjectError):
    """The workbench file does not exist."""


class WorkbenchConflictError(ProjectError):
    """A workbench revision or member conflicts with the current file."""


class ProjectService:
    """File-first project/workbench operations.

    ``workflow_workbench_repo`` is an optional compatibility mirror used by run
    monitoring and the legacy workspace tools.  It is never read as the source
    of truth for this service.
    """

    def __init__(
        self,
        project_repo: ProjectRepository,
        *,
        definition_repo: Any | None = None,
        workbench_repo: Any | None = None,
    ) -> None:
        self._projects = project_repo
        self._definitions = definition_repo
        self._workbench_mirror = workbench_repo

    # 鈹€鈹€ Projects 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    async def create_project(
        self,
        *,
        root_path: str,
        user_id: str,
        name: str | None = None,
        description: str = "",
    ) -> dict[str, Any]:
        try:
            root, manifest = await asyncio.to_thread(
                create_project_files,
                root_path,
                name=(name or Path(root_path).name or "Project"),
                description=description,
            )
        except ProjectFileError as exc:
            if "already exists" in str(exc):
                raise ProjectConflictError(str(exc)) from exc
            raise ProjectError(str(exc)) from exc
        try:
            row = await self._projects.upsert(
                project_id=manifest.project_id,
                user_id=user_id,
                name=manifest.name,
                root_path=str(root),
                manifest_hash=manifest_content_hash(manifest),
            )
        except ProjectRootConflictError as exc:
            raise ProjectConflictError(str(exc)) from exc
        payload = self._project_payload(row, manifest)
        payload["capability_stack"] = await self.capability_stack_status(manifest.project_id, user_id=user_id)
        return payload

    async def open_project(self, *, root_path: str, user_id: str) -> dict[str, Any]:
        try:
            root = await asyncio.to_thread(resolve_project_root, root_path)
            manifest = await asyncio.to_thread(read_manifest, root)
        except (ProjectFileError, OSError) as exc:
            raise ProjectNotFoundError(str(exc)) from exc
        try:
            row = await self._projects.upsert(
                project_id=manifest.project_id,
                user_id=user_id,
                name=manifest.name,
                root_path=str(root),
                manifest_hash=manifest_content_hash(manifest),
            )
        except ProjectRootConflictError as exc:
            raise ProjectConflictError(str(exc)) from exc
        payload = self._project_payload(row, manifest)
        payload["capability_stack"] = await self.capability_stack_status(manifest.project_id, user_id=user_id)
        return payload

    async def list_projects(self, *, user_id: str) -> list[dict[str, Any]]:
        rows = await self._projects.list_by_user(user_id)
        projects: list[dict[str, Any]] = []
        for row in rows:
            try:
                root = await asyncio.to_thread(resolve_project_root, row["root_path"])
                manifest = await asyncio.to_thread(read_manifest, root)
            except Exception as exc:  # noqa: BLE001 - a broken project must stay visible
                projects.append({**row, "id": row["id"], "project_id": row["id"], "error": str(exc), "manifest": None})
                continue
            digest = manifest_content_hash(manifest)
            if row.get("manifest_hash") != digest or row.get("name") != manifest.name:
                try:
                    row = await self._projects.upsert(
                        project_id=manifest.project_id,
                        user_id=user_id,
                        name=manifest.name,
                        root_path=str(root),
                        manifest_hash=digest,
                    )
                except Exception:
                    logger.warning("Failed to refresh project %s metadata from list", row["id"], exc_info=True)
            payload = self._project_payload(row, manifest)
            payload["manifest"] = manifest.model_dump(mode="json")
            payload["capability_stack"] = await asyncio.to_thread(_stack_status, root)
            projects.append(payload)
        return projects

    async def get_project(self, project_id: str, *, user_id: str) -> dict[str, Any]:
        row, root, manifest = await self._load_project(project_id, user_id=user_id)
        payload = self._project_payload(row, manifest)
        payload["manifest"] = manifest.model_dump(mode="json")
        payload["workbenches_path"] = str(root / ".hnflow" / "workbenches")
        payload["capability_stack"] = await self.capability_stack_status(project_id, user_id=user_id)
        return payload

    async def close_project(self, project_id: str, *, user_id: str) -> bool:
        return await self._projects.delete(project_id, user_id=user_id)

    async def _load_project(self, project_id: str, *, user_id: str) -> tuple[dict[str, Any], Path, ProjectManifest]:
        row = await self._projects.get(project_id, user_id=user_id)
        if row is None:
            raise ProjectNotFoundError(f"project {project_id!r} not found")
        try:
            root = await asyncio.to_thread(resolve_project_root, row["root_path"])
            manifest = await asyncio.to_thread(read_manifest, root)
        except Exception as exc:
            raise ProjectNotFoundError(f"project {project_id!r} files are unavailable: {exc}") from exc
        if manifest.project_id != project_id:
            raise ProjectError(f"project manifest id {manifest.project_id!r} does not match registered id {project_id!r}")
        digest = manifest_content_hash(manifest)
        if row.get("manifest_hash") != digest or row.get("name") != manifest.name:
            try:
                row = await self._projects.upsert(
                    project_id=manifest.project_id,
                    user_id=user_id,
                    name=manifest.name,
                    root_path=str(root),
                    manifest_hash=digest,
                )
            except Exception:
                logger.warning("Failed to refresh project %s metadata", project_id, exc_info=True)
        return row, root, manifest

    async def capability_stack_status(self, project_id: str, *, user_id: str) -> dict[str, Any]:
        """Describe the project's ``.vibestack/stack.json`` without creating it."""
        _, root, _ = await self._load_project(project_id, user_id=user_id)
        return await asyncio.to_thread(_stack_status, root)

    async def activate_workflow_groups(self, project_id: str, definition: WorkflowDefinition, *, user_id: str) -> dict[str, Any]:
        """Add/update the groups selected by *definition*; preserve unrelated entries."""
        _, root, _ = await self._load_project(project_id, user_id=user_id)
        references = collect_definition_group_refs(definition)
        if not references:
            ensured, created = await asyncio.to_thread(ensure_project_stack, root, core=default_core())
            return {"changed": created, "created": created, "activated": [], "updated": [], "stack": ensured.to_dict()}
        repository = resolve_repository()
        if repository is None:
            raise ProjectError("VibeStack repository is not configured; set vibestack.repository in config.yaml")
        try:
            result = await asyncio.to_thread(
                activate_definition_groups,
                root,
                repository,
                definition,
                core=default_core(),
            )
        except VibeStackError as exc:
            raise ProjectError(str(exc)) from exc
        return result.to_dict()

    async def ensure_project_stack(self, project_id: str, *, user_id: str) -> dict[str, Any]:
        """Initialize a project stack with Core when it does not exist yet."""
        _, root, _ = await self._load_project(project_id, user_id=user_id)
        try:
            stack, created = await asyncio.to_thread(ensure_project_stack, root, core=default_core())
        except VibeStackError as exc:
            raise ProjectError(str(exc)) from exc
        return {"created": created, "stack": stack.to_dict()}

    @staticmethod
    def _project_payload(row: dict[str, Any], manifest: ProjectManifest) -> dict[str, Any]:
        return {
            "id": row["id"],
            "project_id": manifest.project_id,
            "user_id": row["user_id"],
            "name": manifest.name,
            "description": manifest.description,
            "root_path": row["root_path"],
            "manifest_hash": row["manifest_hash"],
            "default_environment": manifest.default_environment,
            "roots": [root.model_dump(mode="json") for root in manifest.roots],
            "mcp_allowlist": list(manifest.mcp_allowlist),
            "secret_refs": list(manifest.secret_refs),
            "created_at": row.get("created_at"),
            "updated_at": row.get("updated_at"),
        }

    # 鈹€鈹€ Workbenches 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    async def list_workbenches(self, project_id: str, *, user_id: str) -> list[dict[str, Any]]:
        _, root, manifest = await self._load_project(project_id, user_id=user_id)
        files = await asyncio.to_thread(list_workbench_files, root)
        return [await self._workbench_payload(manifest, workbench, user_id=user_id) for workbench in files if workbench.project_id == project_id]

    async def get_workbench(self, project_id: str, workbench_id: str, *, user_id: str) -> dict[str, Any]:
        _, root, manifest = await self._load_project(project_id, user_id=user_id)
        try:
            workbench = await asyncio.to_thread(read_workbench, root, workbench_id)
        except FileNotFoundError as exc:
            raise WorkbenchNotFoundError(f"workbench {workbench_id!r} not found") from exc
        except ProjectFileError as exc:
            raise ProjectError(str(exc)) from exc
        if workbench.project_id != project_id:
            raise ProjectError(f"workbench {workbench_id!r} belongs to project {workbench.project_id!r}")
        payload = await self._workbench_payload(manifest, workbench, user_id=user_id)
        await self._mirror_workbench(payload, workbench, user_id=user_id)
        return payload

    async def create_workbench(
        self,
        project_id: str,
        *,
        user_id: str,
        name: str,
        description: str = "",
        layout: dict[str, Any] | None = None,
        settings: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        _, root, manifest = await self._load_project(project_id, user_id=user_id)
        try:
            _, stack_created = await asyncio.to_thread(ensure_project_stack, root, core=default_core())
        except VibeStackError as exc:
            raise ProjectError(str(exc)) from exc
        now = datetime.now(UTC).isoformat()
        workbench = WorkbenchFile(
            project_id=project_id,
            workbench_id=f"wb-{uuid4().hex}",
            name=name,
            description=description,
            layout=layout if layout is not None else {"version": 1, "cards": []},
            settings=settings or {},
            members=[],
            revision=1,
            created_at=now,
            updated_at=now,
        )
        await asyncio.to_thread(write_workbench, root, workbench)
        payload = await self._workbench_payload(manifest, workbench, user_id=user_id)
        payload["capability_stack_created"] = stack_created
        await self._mirror_workbench(payload, workbench, user_id=user_id)
        return payload

    async def update_workbench(
        self,
        project_id: str,
        workbench_id: str,
        *,
        user_id: str,
        updates: dict[str, Any],
        expected_revision: int | None = None,
    ) -> dict[str, Any]:
        _, root, manifest = await self._load_project(project_id, user_id=user_id)
        try:
            workbench = await asyncio.to_thread(read_workbench, root, workbench_id)
        except FileNotFoundError as exc:
            raise WorkbenchNotFoundError(f"workbench {workbench_id!r} not found") from exc
        except ProjectFileError as exc:
            raise ProjectError(str(exc)) from exc
        if workbench.project_id != project_id:
            raise ProjectError(f"workbench {workbench_id!r} belongs to project {workbench.project_id!r}")
        if expected_revision is not None and expected_revision != workbench.revision:
            raise WorkbenchConflictError(f"workbench revision {expected_revision} is stale (current {workbench.revision})")
        for key in ("name", "description", "layout", "settings"):
            if key in updates and updates[key] is not None:
                setattr(workbench, key, updates[key])
        workbench.revision += 1
        workbench.updated_at = datetime.now(UTC).isoformat()
        try:
            WorkbenchFile.model_validate(workbench.model_dump(mode="json"))
        except Exception as exc:
            raise ProjectError(f"invalid workbench update: {exc}") from exc
        await asyncio.to_thread(write_workbench, root, workbench)
        payload = await self._workbench_payload(manifest, workbench, user_id=user_id)
        await self._mirror_workbench(payload, workbench, user_id=user_id)
        return payload

    async def delete_workbench(self, project_id: str, workbench_id: str, *, user_id: str) -> bool:
        _, root, _ = await self._load_project(project_id, user_id=user_id)
        deleted = await asyncio.to_thread(delete_workbench_file, root, workbench_id)
        if deleted and self._workbench_mirror is not None:
            try:
                await self._workbench_mirror.delete(workbench_id, user_id=user_id)
            except Exception:  # noqa: BLE001 - mirror cleanup is best effort
                logger.warning("Failed to remove workbench mirror %s", workbench_id, exc_info=True)
        return deleted

    async def add_member(
        self,
        project_id: str,
        workbench_id: str,
        *,
        user_id: str,
        definition_id: str,
        settings: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        definition_row = await self._require_definition(definition_id, user_id=user_id)
        raw_definition = definition_row.get("definition") if isinstance(definition_row, dict) else getattr(definition_row, "definition", None)
        try:
            definition = WorkflowDefinition.model_validate(raw_definition)
        except Exception as exc:  # noqa: BLE001 - the member must be runnable before it is added
            raise ProjectError(f"workflow definition {definition_id!r} is invalid: {exc}") from exc
        _, root, manifest = await self._load_project(project_id, user_id=user_id)
        try:
            workbench = await asyncio.to_thread(read_workbench, root, workbench_id)
        except FileNotFoundError as exc:
            raise WorkbenchNotFoundError(f"workbench {workbench_id!r} not found") from exc
        if any(member.definition_id == definition_id for member in workbench.members):
            raise WorkbenchConflictError("workflow is already a member of this workbench")
        activation = await self.activate_workflow_groups(project_id, definition, user_id=user_id)
        order_index = max((member.order_index for member in workbench.members), default=-1) + 1
        workbench.members.append(WorkbenchMember(definition_id=definition_id, order_index=order_index, settings=settings or {}))
        workbench.revision += 1
        workbench.updated_at = datetime.now(UTC).isoformat()
        await asyncio.to_thread(write_workbench, root, workbench)
        payload = await self._workbench_payload(manifest, workbench, user_id=user_id)
        await self._mirror_workbench(payload, workbench, user_id=user_id)
        member = next(member for member in payload["members"] if member["definition_id"] == definition_id)
        member["activation"] = activation
        return member

    async def remove_member(self, project_id: str, workbench_id: str, definition_id: str, *, user_id: str) -> bool:
        _, root, manifest = await self._load_project(project_id, user_id=user_id)
        try:
            workbench = await asyncio.to_thread(read_workbench, root, workbench_id)
        except FileNotFoundError as exc:
            raise WorkbenchNotFoundError(f"workbench {workbench_id!r} not found") from exc
        remaining = [member for member in workbench.members if member.definition_id != definition_id]
        if len(remaining) == len(workbench.members):
            return False
        workbench.members = remaining
        workbench.revision += 1
        workbench.updated_at = datetime.now(UTC).isoformat()
        await asyncio.to_thread(write_workbench, root, workbench)
        payload = await self._workbench_payload(manifest, workbench, user_id=user_id)
        await self._mirror_workbench(payload, workbench, user_id=user_id)
        return True

    async def remove_definition_memberships(self, definition_id: str, *, user_id: str) -> int:
        """Remove one workflow from every file-backed workbench owned by the user."""
        removed = 0
        for row in await self._projects.list_by_user(user_id):
            try:
                root = await asyncio.to_thread(resolve_project_root, row["root_path"])
                manifest = await asyncio.to_thread(read_manifest, root)
            except Exception:
                continue
            workbenches = await asyncio.to_thread(list_workbench_files, root)
            for workbench in workbenches:
                if workbench.project_id != manifest.project_id:
                    continue
                remaining = [member for member in workbench.members if member.definition_id != definition_id]
                if len(remaining) == len(workbench.members):
                    continue
                workbench.members = remaining
                workbench.revision += 1
                workbench.updated_at = datetime.now(UTC).isoformat()
                await asyncio.to_thread(write_workbench, root, workbench)
                payload = await self._workbench_payload(manifest, workbench, user_id=user_id)
                await self._mirror_workbench(payload, workbench, user_id=user_id)
                removed += 1
        return removed

    async def _require_definition(self, definition_id: str, *, user_id: str) -> dict[str, Any]:
        if self._definitions is None:
            raise ProjectError("workflow definition repository is unavailable")
        definition = await self._definitions.get(definition_id, user_id=user_id)
        if definition is None:
            raise ProjectError(f"workflow definition {definition_id!r} not found")
        return definition

    async def _workbench_payload(self, manifest: ProjectManifest, workbench: WorkbenchFile, *, user_id: str) -> dict[str, Any]:
        members: list[dict[str, Any]] = []
        for member in workbench.members:
            definition = None
            if self._definitions is not None:
                try:
                    definition = await self._definitions.get(member.definition_id, user_id=user_id)
                except Exception:  # noqa: BLE001 - missing definition is data, not a list failure
                    logger.warning("Failed to load workflow %s for workbench %s", member.definition_id, workbench.workbench_id, exc_info=True)
            members.append(
                {
                    "id": f"{workbench.workbench_id}:{member.definition_id}",
                    "workbench_id": workbench.workbench_id,
                    "definition_id": member.definition_id,
                    "order_index": member.order_index,
                    "settings": member.settings,
                    "created_at": workbench.created_at,
                    "definition_name": definition.get("name") if isinstance(definition, dict) else None,
                    "definition_version": definition.get("version") if isinstance(definition, dict) else None,
                    "definition_exists": definition is not None,
                }
            )
        return {
            "id": workbench.workbench_id,
            "user_id": user_id,
            "project_id": manifest.project_id,
            "name": workbench.name,
            "description": workbench.description,
            "layout": workbench.layout,
            "settings": workbench.settings,
            "revision": workbench.revision,
            "member_count": len(members),
            "members": members,
            "created_at": workbench.created_at,
            "updated_at": workbench.updated_at,
        }

    async def _mirror_workbench(self, payload: dict[str, Any], workbench: WorkbenchFile, *, user_id: str) -> None:
        if self._workbench_mirror is None:
            return
        try:
            await self._workbench_mirror.mirror_file_workbench(
                workbench_id=workbench.workbench_id,
                user_id=user_id,
                project_id=workbench.project_id,
                name=workbench.name,
                description=workbench.description,
                layout=workbench.layout,
                settings=workbench.settings,
                revision=workbench.revision,
                members=[member.model_dump(mode="json") for member in workbench.members],
            )
        except Exception:  # noqa: BLE001 - the file remains authoritative
            logger.warning("Failed to mirror workbench %s into SQL", workbench.workbench_id, exc_info=True)


__all__ = [
    "ProjectConflictError",
    "ProjectError",
    "ProjectNotFoundError",
    "ProjectService",
    "WorkbenchConflictError",
    "WorkbenchNotFoundError",
]
