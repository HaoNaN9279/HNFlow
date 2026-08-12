"""workflow definitions.

Revision ID: 0012_workflow_definitions
Revises: 0011_mcp_tasks
Create Date: 2026-08-12
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0012_workflow_definitions"
down_revision: str | Sequence[str] | None = "0011_mcp_tasks"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("workflow_definitions"):
        return

    op.create_table(
        "workflow_definitions",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("definition", sa.JSON(), nullable=False),
        sa.Column("metadata", sa.JSON(), nullable=False),
        sa.Column("version", sa.String(length=32), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("workflow_definitions", schema=None) as batch_op:
        batch_op.create_index("ix_workflow_definitions_user_id", ["user_id"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("workflow_definitions", schema=None) as batch_op:
        batch_op.drop_index("ix_workflow_definitions_user_id")
    op.drop_table("workflow_definitions")
