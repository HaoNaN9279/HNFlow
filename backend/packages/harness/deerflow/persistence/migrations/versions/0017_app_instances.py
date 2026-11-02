"""app instances.

Revision ID: 0017_app_instances
Revises: 0016_drop_feedback_table
Create Date: 2026-10-13
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0017_app_instances"
down_revision: str | Sequence[str] | None = "0016_drop_feedback_table"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("app_instances"):
        return

    op.create_table(
        "app_instances",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.String(length=64), nullable=False),
        sa.Column("app_name", sa.String(length=64), nullable=False),
        sa.Column("driver", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("pid", sa.Integer(), nullable=True),
        sa.Column("endpoint", sa.String(length=512), nullable=True),
        sa.Column("handle", sa.JSON(), nullable=False),
        sa.Column("exclusive", sa.Boolean(), nullable=False),
        sa.Column("resources", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_active", sa.DateTime(timezone=True), nullable=False),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("app_instances", schema=None) as batch_op:
        batch_op.create_index("ix_app_instances_user_id", ["user_id"], unique=False)
        batch_op.create_index("ix_app_instances_status", ["status"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("app_instances", schema=None) as batch_op:
        batch_op.drop_index("ix_app_instances_status")
        batch_op.drop_index("ix_app_instances_user_id")
    op.drop_table("app_instances")
