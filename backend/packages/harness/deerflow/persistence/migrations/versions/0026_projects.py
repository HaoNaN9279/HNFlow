"""file-backed projects + project-scoped workbench index.

Revision ID: 0026_projects
Revises: 0025_workflow_specifications
Create Date: 2026-10-26

Projects are directories with ``.hnflow/project.json``.  Workbenches are JSON
files inside the project; the SQL row is only an internal mirror for run
monitoring and legacy workspace tooling.  Existing DB-only workbenches are not
migrated and are deleted by this revision.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0026_projects"
down_revision: str | Sequence[str] | None = "0025_workflow_specifications"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_PROJECTS = "projects"
_WORKBENCHES = "workflow_workbenches"
_MEMBERS = "workflow_workbench_members"
_PROJECTS_USER_INDEX = "ix_projects_user_id"
_PROJECTS_ROOT_UNIQUE = "uq_projects_user_root"
_WORKBENCH_PROJECT_INDEX = "ix_workflow_workbenches_project_id"


def upgrade() -> None:
    from deerflow.persistence.migrations._helpers import safe_add_column

    insp = sa.inspect(op.get_bind())
    tables = set(insp.get_table_names())

    if _PROJECTS not in tables:
        op.create_table(
            _PROJECTS,
            sa.Column("id", sa.String(length=64), primary_key=True),
            sa.Column("user_id", sa.String(length=64), nullable=False),
            sa.Column("name", sa.String(length=255), nullable=False),
            sa.Column("root_path", sa.String(length=2048), nullable=False),
            sa.Column("manifest_hash", sa.String(length=64), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("user_id", "root_path", name=_PROJECTS_ROOT_UNIQUE),
        )
        op.create_index(_PROJECTS_USER_INDEX, _PROJECTS, ["user_id"])

    if _WORKBENCHES in tables:
        safe_add_column(_WORKBENCHES, sa.Column("project_id", sa.String(length=64), nullable=True))
        indexes = {index["name"] for index in sa.inspect(op.get_bind()).get_indexes(_WORKBENCHES)}
        if _WORKBENCH_PROJECT_INDEX not in indexes:
            op.create_index(_WORKBENCH_PROJECT_INDEX, _WORKBENCHES, ["project_id"])

        # No migration from the old DB-only workbenches.  Keep the table as an
        # internal mirror for the new file-backed workbenches, but remove every
        # legacy row (project_id IS NULL).
        if _MEMBERS in tables:
            op.execute(sa.text(f"DELETE FROM {_MEMBERS} WHERE workbench_id IN (SELECT id FROM {_WORKBENCHES} WHERE project_id IS NULL)"))
        op.execute(sa.text(f"DELETE FROM {_WORKBENCHES} WHERE project_id IS NULL"))


def downgrade() -> None:
    from deerflow.persistence.migrations._helpers import safe_drop_column

    insp = sa.inspect(op.get_bind())
    tables = set(insp.get_table_names())
    if _WORKBENCHES in tables:
        indexes = {index["name"] for index in sa.inspect(op.get_bind()).get_indexes(_WORKBENCHES)}
        if _WORKBENCH_PROJECT_INDEX in indexes:
            op.drop_index(_WORKBENCH_PROJECT_INDEX, table_name=_WORKBENCHES)
        safe_drop_column(_WORKBENCHES, "project_id")
    if _PROJECTS in tables:
        indexes = {index["name"] for index in sa.inspect(op.get_bind()).get_indexes(_PROJECTS)}
        if _PROJECTS_USER_INDEX in indexes:
            op.drop_index(_PROJECTS_USER_INDEX, table_name=_PROJECTS)
        op.drop_table(_PROJECTS)
