"""File-backed projects and workbenches.

A project is a directory containing ``.hnflow/project.json``.  Workbenches are
JSON files under ``.hnflow/workbenches``.  Files are the source of truth for
these resources; the SQL workbench row is an internal mirror used by run
monitoring and the workspace tools.
"""

from deerflow.projects.schema import (
    PROJECT_SCHEMA_VERSION,
    WORKBENCH_SCHEMA_VERSION,
    ProjectManifest,
    WorkbenchFile,
    WorkbenchMember,
)
from deerflow.projects.service import (
    ProjectConflictError,
    ProjectError,
    ProjectNotFoundError,
    ProjectService,
    WorkbenchConflictError,
    WorkbenchNotFoundError,
)

__all__ = [
    "PROJECT_SCHEMA_VERSION",
    "WORKBENCH_SCHEMA_VERSION",
    "ProjectConflictError",
    "ProjectError",
    "ProjectManifest",
    "ProjectNotFoundError",
    "ProjectService",
    "WorkbenchConflictError",
    "WorkbenchFile",
    "WorkbenchMember",
    "WorkbenchNotFoundError",
]
