"""human tasks.

Revision ID: 0013_human_tasks
Revises: 0012_workflow_definitions
Create Date: 2026-08-13
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0013_human_tasks"
down_revision: str | Sequence[str] | None = "0012_workflow_definitions"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("human_tasks"):
        return

    op.create_table(
        "human_tasks",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.String(length=64), nullable=False),
        sa.Column("workflow_run_id", sa.String(length=64), nullable=False),
        sa.Column("node_id", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("description", sa.String(length=512), nullable=False),
        sa.Column("inputs_snapshot", sa.JSON(), nullable=False),
        sa.Column("output_spec", sa.JSON(), nullable=False),
        sa.Column("validation_rules", sa.JSON(), nullable=False),
        sa.Column("checkpoint_ref", sa.JSON(), nullable=True),
        sa.Column("submission", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("human_tasks", schema=None) as batch_op:
        batch_op.create_index("ix_human_tasks_user_id", ["user_id"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("human_tasks", schema=None) as batch_op:
        batch_op.drop_index("ix_human_tasks_user_id")
    op.drop_table("human_tasks")
