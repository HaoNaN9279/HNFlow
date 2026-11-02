"""workflow directory folders and a clean workflow slate.

Revision ID: 0022_workflow_folders
Revises: 0021_workflow_workbenches
Create Date: 2026-10-21

Adds an arbitrary-depth folder tree (``workflow_folders``) and
``workflow_definitions.folder_id``.  Per the product decision, old workflow
content is intentionally not migrated: existing definitions, revisions,
workbench memberships, pending human tasks and undo records are cleared so the
directory starts from a consistent empty slate.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0022_workflow_folders"
down_revision: str | Sequence[str] | None = "0021_workflow_workbenches"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_FOLDER_TABLE = "workflow_folders"
_FOLDER_USER_INDEX = "ix_workflow_folders_user_id"
_FOLDER_PARENT_INDEX = "ix_workflow_folders_parent_id"
_FOLDER_ORDER_INDEX = "ix_workflow_folders_user_parent_order"
_DEFINITION_FOLDER_INDEX = "ix_workflow_definitions_folder_id"


def upgrade() -> None:
    from deerflow.persistence.migrations._helpers import safe_add_column

    safe_add_column("workflow_definitions", sa.Column("folder_id", sa.String(length=64), nullable=True))

    insp = sa.inspect(op.get_bind())
    table_names = set(insp.get_table_names())
    if _FOLDER_TABLE not in table_names:
        op.create_table(
            _FOLDER_TABLE,
            sa.Column("id", sa.String(length=64), primary_key=True),
            sa.Column("user_id", sa.String(length=64), nullable=False),
            sa.Column("name", sa.String(length=255), nullable=False),
            sa.Column("parent_id", sa.String(length=64), nullable=True),
            sa.Column("order_index", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index(_FOLDER_USER_INDEX, _FOLDER_TABLE, ["user_id"])
        op.create_index(_FOLDER_PARENT_INDEX, _FOLDER_TABLE, ["parent_id"])
        op.create_index(_FOLDER_ORDER_INDEX, _FOLDER_TABLE, ["user_id", "parent_id", "order_index"])

    definition_indexes = {ix["name"] for ix in insp.get_indexes("workflow_definitions")}
    if _DEFINITION_FOLDER_INDEX not in definition_indexes:
        op.create_index(_DEFINITION_FOLDER_INDEX, "workflow_definitions", ["folder_id"])

    # Deliberate destructive reset: no old workflow content is migrated.
    for statement in (
        "DELETE FROM workflow_workbench_members",
        "DELETE FROM human_tasks",
        "DELETE FROM workflow_undo_records",
        "DELETE FROM workflow_definition_revisions",
        "DELETE FROM workflow_definitions",
    ):
        if sa.inspect(op.get_bind()).has_table(statement.split()[-1]):
            op.execute(sa.text(statement))


def downgrade() -> None:
    from deerflow.persistence.migrations._helpers import safe_drop_column

    insp = sa.inspect(op.get_bind())
    if _FOLDER_TABLE in set(insp.get_table_names()):
        existing = {ix["name"] for ix in insp.get_indexes(_FOLDER_TABLE)}
        for name in (_FOLDER_ORDER_INDEX, _FOLDER_PARENT_INDEX, _FOLDER_USER_INDEX):
            if name in existing:
                op.drop_index(name, table_name=_FOLDER_TABLE)
        op.drop_table(_FOLDER_TABLE)
    definition_indexes = {ix["name"] for ix in insp.get_indexes("workflow_definitions")}
    if _DEFINITION_FOLDER_INDEX in definition_indexes:
        op.drop_index(_DEFINITION_FOLDER_INDEX, table_name="workflow_definitions")
    safe_drop_column("workflow_definitions", "folder_id")
