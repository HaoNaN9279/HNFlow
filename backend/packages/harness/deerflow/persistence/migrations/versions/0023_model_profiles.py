"""model profiles: AI nodes reference a logical profile, which points at one LLM.

Revision ID: 0023_model_profiles
Revises: 0022_workflow_folders
Create Date: 2026-10-21
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0023_model_profiles"
down_revision: str | Sequence[str] | None = "0022_workflow_folders"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "model_profiles"
_USER_INDEX = "ix_model_profiles_user_id"
_NAME_UNIQUE = "uq_model_profiles_user_name"


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if _TABLE in set(insp.get_table_names()):
        return
    op.create_table(
        _TABLE,
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("user_id", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("display_name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("target_model", sa.String(length=128), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("1")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "name", name=_NAME_UNIQUE),
    )
    op.create_index(_USER_INDEX, _TABLE, ["user_id"])


def downgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if _TABLE not in set(insp.get_table_names()):
        return
    existing = {ix["name"] for ix in insp.get_indexes(_TABLE)}
    if _USER_INDEX in existing:
        op.drop_index(_USER_INDEX, table_name=_TABLE)
    op.drop_table(_TABLE)
