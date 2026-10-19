"""workflow definition revisions.

Revision ID: 0020_workflow_definition_revisions
Revises: 0019_human_task_kind_and_undo
Create Date: 2026-10-19

Immutable snapshots of saved workflow definitions.  A run pins the definition it
was admitted with instead of silently following a later edit.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0020_workflow_definition_revisions"
down_revision: str | Sequence[str] | None = "0019_human_task_kind_and_undo"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "workflow_definition_revisions"
_INDEX_DEFINITION = "ix_workflow_definition_revisions_definition_id"
_INDEX_USER = "ix_workflow_definition_revisions_user_id"
_UNIQUE = "uq_workflow_definition_revision"


def upgrade() -> None:
    # The empty/legacy bootstrap path may have created the table from ORM
    # metadata before alembic reaches this revision.
    insp = sa.inspect(op.get_bind())
    if _TABLE in set(insp.get_table_names()):
        return

    op.create_table(
        _TABLE,
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("definition_id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.String(length=64), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("definition", sa.JSON(), nullable=False),
        sa.Column("metadata", sa.JSON(), nullable=False),
        sa.Column("version", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("definition_id", "revision", name=_UNIQUE),
    )
    op.create_index(_INDEX_DEFINITION, _TABLE, ["definition_id"])
    op.create_index(_INDEX_USER, _TABLE, ["user_id"])


def downgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if _TABLE not in set(insp.get_table_names()):
        return
    existing = {ix["name"] for ix in insp.get_indexes(_TABLE)}
    for name in (_INDEX_DEFINITION, _INDEX_USER):
        if name in existing:
            op.drop_index(name, table_name=_TABLE)
    op.drop_table(_TABLE)
