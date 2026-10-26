"""formal verification: immutable specification head + revisions.

Revision ID: 0025_workflow_specifications
Revises: 0024_workspace_resource_changes
Create Date: 2026-10-26
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0025_workflow_specifications"
down_revision: str | Sequence[str] | None = "0024_workspace_resource_changes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_HEAD = "workflow_specifications"
_REVISION = "workflow_specification_revisions"
_HEAD_USER_INDEX = "ix_workflow_specifications_user_id"
_REVISION_SPEC_INDEX = "ix_workflow_specification_revisions_spec_id"
_REVISION_USER_INDEX = "ix_workflow_specification_revisions_user_id"
_REVISION_UNIQUE = "uq_workflow_specification_revision"


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    tables = set(insp.get_table_names())
    if _HEAD not in tables:
        op.create_table(
            _HEAD,
            sa.Column("id", sa.String(length=64), primary_key=True),
            sa.Column("user_id", sa.String(length=64), nullable=False),
            sa.Column("name", sa.String(length=255), nullable=False),
            sa.Column("language", sa.String(length=16), nullable=False),
            sa.Column("current_revision", sa.Integer(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index(_HEAD_USER_INDEX, _HEAD, ["user_id"])

    if _REVISION not in tables:
        op.create_table(
            _REVISION,
            sa.Column("id", sa.String(length=64), primary_key=True),
            sa.Column("spec_id", sa.String(length=64), nullable=False),
            sa.Column("user_id", sa.String(length=64), nullable=False),
            sa.Column("revision", sa.Integer(), nullable=False),
            sa.Column("language", sa.String(length=16), nullable=False),
            sa.Column("content", sa.Text(), nullable=False),
            sa.Column("content_hash", sa.String(length=80), nullable=False),
            sa.Column("status", sa.String(length=16), nullable=False),
            sa.Column("title", sa.String(length=255), nullable=True),
            sa.Column("metadata", sa.JSON(), nullable=False),
            sa.Column("approved_by", sa.String(length=64), nullable=True),
            sa.Column("approval_task_id", sa.String(length=64), nullable=True),
            sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("spec_id", "revision", name=_REVISION_UNIQUE),
        )
        op.create_index(_REVISION_SPEC_INDEX, _REVISION, ["spec_id"])
        op.create_index(_REVISION_USER_INDEX, _REVISION, ["user_id"])


def downgrade() -> None:
    insp = sa.inspect(op.get_bind())
    tables = set(insp.get_table_names())
    if _REVISION in tables:
        existing = {ix["name"] for ix in insp.get_indexes(_REVISION)}
        for index in (_REVISION_SPEC_INDEX, _REVISION_USER_INDEX):
            if index in existing:
                op.drop_index(index, table_name=_REVISION)
        op.drop_table(_REVISION)
    if _HEAD in tables:
        existing = {ix["name"] for ix in insp.get_indexes(_HEAD)}
        if _HEAD_USER_INDEX in existing:
            op.drop_index(_HEAD_USER_INDEX, table_name=_HEAD)
        op.drop_table(_HEAD)
