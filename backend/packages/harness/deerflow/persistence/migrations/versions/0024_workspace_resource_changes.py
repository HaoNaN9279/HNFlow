"""workspace resource change journal for Lead Agent undo.

Revision ID: 0024_workspace_resource_changes
Revises: 0023_model_profiles
Create Date: 2026-10-22
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0024_workspace_resource_changes"
down_revision: str | Sequence[str] | None = "0023_model_profiles"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "workspace_resource_changes"
_THREAD_SEQ_INDEX = "ix_workspace_resource_changes_thread_seq"


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if _TABLE in set(insp.get_table_names()):
        return
    op.create_table(
        _TABLE,
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("user_id", sa.String(length=64), nullable=False),
        sa.Column("thread_id", sa.String(length=128), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=True),
        sa.Column("tool_call_id", sa.String(length=128), nullable=True),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("resource_kind", sa.String(length=32), nullable=False),
        sa.Column("resource_id", sa.String(length=128), nullable=False),
        sa.Column("parent_id", sa.String(length=128), nullable=True),
        sa.Column("action", sa.String(length=32), nullable=False),
        sa.Column("before_json", sa.JSON(), nullable=True),
        sa.Column("after_json", sa.JSON(), nullable=True),
        sa.Column("before_token", sa.String(length=160), nullable=True),
        sa.Column("after_token", sa.String(length=160), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("detail", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("undone_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_workspace_resource_changes_user_id", _TABLE, ["user_id"])
    op.create_index("ix_workspace_resource_changes_thread_id", _TABLE, ["thread_id"])
    op.create_index("ix_workspace_resource_changes_run_id", _TABLE, ["run_id"])
    op.create_index(_THREAD_SEQ_INDEX, _TABLE, ["thread_id", "seq"])


def downgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if _TABLE not in set(insp.get_table_names()):
        return
    existing = {ix["name"] for ix in insp.get_indexes(_TABLE)}
    for name in (
        _THREAD_SEQ_INDEX,
        "ix_workspace_resource_changes_run_id",
        "ix_workspace_resource_changes_thread_id",
        "ix_workspace_resource_changes_user_id",
    ):
        if name in existing:
            op.drop_index(name, table_name=_TABLE)
    op.drop_table(_TABLE)
