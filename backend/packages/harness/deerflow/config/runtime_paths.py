"""Runtime path resolution for standalone harness usage."""

import os
from pathlib import Path

#: Canonical user-data directory name under the project root.
USER_DATA_DIRNAME = "hnflow-data"


def _looks_like_hnflow_checkout(candidate: Path) -> bool:
    """Return whether *candidate* is the repository root of this checkout."""
    return (candidate / "config.example.yaml").is_file() and (candidate / "backend" / "packages" / "harness").is_dir()


def project_root() -> Path:
    """Return the caller project root for runtime-owned files.

    Inside this monorepo, the repository root wins over the current working
    directory so running ``uvicorn``/``pytest`` from ``backend/`` still resolves
    the single ``hnflow-data/`` root at the repository top.  Standalone harness
    consumers without a checkout marker keep the historical cwd behaviour.
    """
    if env_root := os.getenv("DEER_FLOW_PROJECT_ROOT"):
        root = Path(env_root).resolve()
        if not root.exists():
            raise ValueError(f"DEER_FLOW_PROJECT_ROOT is set to '{env_root}', but the resolved path '{root}' does not exist.")
        if not root.is_dir():
            raise ValueError(f"DEER_FLOW_PROJECT_ROOT is set to '{env_root}', but the resolved path '{root}' is not a directory.")
        return root

    cwd = Path.cwd().resolve()
    for candidate in (cwd, *cwd.parents):
        if _looks_like_hnflow_checkout(candidate):
            return candidate
    return cwd


def user_data_home() -> Path:
    """Return the unified HNFlow user-data directory.

    ``HNFLOW_HOME`` is the canonical override.  ``DEER_FLOW_HOME`` remains a
    supported alias for existing deployments and test isolation; it is the
    only environment variable the previous layout exposed.  The default is
    ``{project_root}/hnflow-data``.
    """
    if env_home := os.getenv("HNFLOW_HOME"):
        return Path(env_home).resolve()
    if env_home := os.getenv("DEER_FLOW_HOME"):
        return Path(env_home).resolve()
    return project_root() / USER_DATA_DIRNAME


def runtime_home() -> Path:
    """Return the writable HNFlow user-data directory.

    Retained under the historical name because :class:`Paths` and the
    persistence layer consume it; semantically it is the unified data root,
    not only runtime state.
    """
    return user_data_home()


def resolve_path(value: str | os.PathLike[str], *, base: Path | None = None) -> Path:
    """Resolve absolute paths as-is and relative paths against the project root."""
    path = Path(value)
    if not path.is_absolute():
        path = (base or project_root()) / path
    return path.resolve()


def existing_project_file(names: tuple[str, ...]) -> Path | None:
    """Return the first existing named file under the project root."""
    root = project_root()
    for name in names:
        candidate = root / name
        if candidate.is_file():
            return candidate
    return None
