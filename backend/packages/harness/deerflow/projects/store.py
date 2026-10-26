"""Filesystem storage for project manifests and workbench files."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any

from deerflow.locks.file_lock import resource_lock
from deerflow.projects.schema import ProjectManifest, WorkbenchFile

logger = logging.getLogger(__name__)

PROJECT_DIR_NAME = ".hnflow"
PROJECT_MANIFEST_NAME = "project.json"
WORKBENCH_DIR_NAME = "workbenches"
WORKBENCH_SUFFIX = ".workbench.json"
LOCAL_OVERRIDE_NAME = "local.json"
_MAX_JSON_BYTES = 2 * 1024 * 1024


class ProjectFileError(ValueError):
    """A project path or file is invalid."""


def resolve_project_root(root_path: str | os.PathLike[str], *, must_exist: bool = True) -> Path:
    """Resolve a project root and normalize duplicate checks across platforms."""
    raw = Path(root_path).expanduser()
    try:
        resolved = raw.resolve(strict=must_exist)
    except FileNotFoundError as exc:
        raise ProjectFileError(f"project root does not exist: {raw}") from exc
    if not resolved.is_dir():
        raise ProjectFileError(f"project root is not a directory: {resolved}")
    return resolved


def normalized_root_key(root_path: str | os.PathLike[str]) -> str:
    """Case-normalized key for duplicate-root checks."""
    return os.path.normcase(str(Path(root_path).resolve(strict=False)))


def project_dir(root: Path) -> Path:
    return root / PROJECT_DIR_NAME


def manifest_path(root: Path) -> Path:
    return project_dir(root) / PROJECT_MANIFEST_NAME


def workbenches_dir(root: Path) -> Path:
    return project_dir(root) / WORKBENCH_DIR_NAME


def workbench_path(root: Path, workbench_id: str) -> Path:
    if not workbench_id or any(part in workbench_id for part in ("/", "\\", "..")):
        raise ProjectFileError(f"invalid workbench id: {workbench_id!r}")
    return workbenches_dir(root) / f"{workbench_id}{WORKBENCH_SUFFIX}"


def _lock_name(root: Path) -> str:
    digest = hashlib.sha256(normalized_root_key(root).encode("utf-8")).hexdigest()[:24]
    return f"project_{digest}"


def project_lock(root: Path):
    return resource_lock(_lock_name(root))


def _read_json(path: Path) -> dict[str, Any]:
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise ProjectFileError(f"cannot read {path}: {exc}") from exc
    if size > _MAX_JSON_BYTES:
        raise ProjectFileError(f"{path} is too large ({size} bytes; max {_MAX_JSON_BYTES})")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ProjectFileError(f"cannot parse {path}: {exc}") from exc
    if not isinstance(raw, dict):
        raise ProjectFileError(f"{path} must contain a JSON object")
    return raw


def _atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    temp_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
            newline="\n",
        ) as handle:
            temp_name = handle.name
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
        temp_name = None
    finally:
        if temp_name is not None:
            try:
                Path(temp_name).unlink(missing_ok=True)
            except OSError:
                logger.warning("failed to remove temporary project file %s", temp_name, exc_info=True)


def read_manifest(root: Path) -> ProjectManifest:
    path = manifest_path(root)
    if not path.is_file():
        raise ProjectFileError(f"{path} does not exist")
    try:
        return ProjectManifest.model_validate(_read_json(path))
    except ProjectFileError:
        raise
    except Exception as exc:
        raise ProjectFileError(f"invalid project manifest {path}: {exc}") from exc


def write_manifest(root: Path, manifest: ProjectManifest) -> None:
    with project_lock(root):
        _atomic_write_json(manifest_path(root), manifest.model_dump(mode="json"))


def create_project_files(root_path: str | os.PathLike[str], *, name: str, description: str = "") -> tuple[Path, ProjectManifest]:
    """Create ``.hnflow`` in *root_path* and return the resolved root/manifest."""
    from uuid import uuid4

    raw = Path(root_path).expanduser()
    raw.mkdir(parents=True, exist_ok=True)
    root = resolve_project_root(raw)
    path = manifest_path(root)
    with project_lock(root):
        if path.is_file():
            raise ProjectFileError(f"project already exists at {root}")
        manifest = ProjectManifest(
            project_id=f"proj-{uuid4().hex}",
            name=name,
            description=description,
        )
        _atomic_write_json(path, manifest.model_dump(mode="json"))
        workbenches_dir(root).mkdir(parents=True, exist_ok=True)
        gitignore = project_dir(root) / ".gitignore"
        if not gitignore.exists():
            gitignore.write_text(f"{LOCAL_OVERRIDE_NAME}\n*.tmp\n", encoding="utf-8")
    logger.info("Created project %s at %s", manifest.project_id, root)
    return root, manifest


def read_workbench(root: Path, workbench_id: str) -> WorkbenchFile:
    path = workbench_path(root, workbench_id)
    if not path.is_file():
        raise FileNotFoundError(path)
    try:
        return WorkbenchFile.model_validate(_read_json(path))
    except ProjectFileError:
        raise
    except Exception as exc:
        raise ProjectFileError(f"invalid workbench file {path}: {exc}") from exc


def list_workbench_files(root: Path) -> list[WorkbenchFile]:
    directory = workbenches_dir(root)
    if not directory.is_dir():
        return []
    workbenches: list[WorkbenchFile] = []
    for path in sorted(directory.glob(f"*{WORKBENCH_SUFFIX}")):
        workbench_id = path.name[: -len(WORKBENCH_SUFFIX)]
        try:
            workbenches.append(read_workbench(root, workbench_id))
        except (FileNotFoundError, ProjectFileError) as exc:
            logger.warning("Skipping malformed workbench file %s: %s", path, exc)
    return workbenches


def write_workbench(root: Path, workbench: WorkbenchFile) -> None:
    with project_lock(root):
        _atomic_write_json(workbench_path(root, workbench.workbench_id), workbench.model_dump(mode="json"))


def delete_workbench_file(root: Path, workbench_id: str) -> bool:
    path = workbench_path(root, workbench_id)
    with project_lock(root):
        try:
            path.unlink()
        except FileNotFoundError:
            return False
    return True


def manifest_content_hash(manifest: ProjectManifest) -> str:
    payload = json.dumps(manifest.model_dump(mode="json"), sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def workbench_content_hash(workbench: WorkbenchFile) -> str:
    payload = json.dumps(workbench.model_dump(mode="json"), sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


__all__ = [
    "LOCAL_OVERRIDE_NAME",
    "PROJECT_DIR_NAME",
    "PROJECT_MANIFEST_NAME",
    "WORKBENCH_DIR_NAME",
    "WORKBENCH_SUFFIX",
    "ProjectFileError",
    "create_project_files",
    "delete_workbench_file",
    "list_workbench_files",
    "manifest_content_hash",
    "manifest_path",
    "normalized_root_key",
    "project_dir",
    "project_lock",
    "read_manifest",
    "read_workbench",
    "resolve_project_root",
    "workbench_content_hash",
    "workbench_path",
    "workbenches_dir",
    "write_manifest",
    "write_workbench",
]
