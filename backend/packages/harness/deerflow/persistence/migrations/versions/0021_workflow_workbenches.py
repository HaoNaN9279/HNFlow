"""workflow workbenches + run launch provenance.

Revision ID: 0021_workflow_workbenches
Revises: 0020_workflow_definition_revisions
Create Date: 2026-10-21

A workbench is a saved monitoring surface.  It references root workflow
definitions and never participates in graph compilation or run lifecycle.
``runs.workbench_id`` records where a manual run was launched so different
workbenches stay isolated while the global monitor can still aggregate.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0021_workflow_workbenches"
down_revision: str | Sequence[str] | None = "0020_workflow_definition_revisions"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_WORKBENCH_TABLE = "workflow_workbenches"
_MEMBER_TABLE = "workflow_workbench_members"
_RUN_WORKBENCH_INDEX = "ix_runs_workbench_id"
_MEMBER_ORDER_INDEX = "ix_workflow_workbench_members_workbench_order"
_MEMBER_UNIQUE = "uq_workflow_workbench_member"


def upgrade() -> None:
    from deerflow.persistence.migrations._helpers import safe_add_column

    safe_add_column("runs", sa.Column("workbench_id", sa.String(length=64), nullable=True))

    insp = sa.inspect(op.get_bind())
    run_indexes = {ix["name"] for ix in insp.get_indexes("runs")}
    if _RUN_WORKBENCH_INDEX not in run_indexes:
        op.create_index(_RUN_WORKBENCH_INDEX, "runs", ["workbench_id"])

    tables = set(insp.get_table_names())
    if _WORKBENCH_TABLE not in tables:
        op.create_table(
            _WORKBENCH_TABLE,
            sa.Column("id", sa.String(length=64), primary_key=True),
            sa.Column("user_id", sa.String(length=64), nullable=False, index=True),
            sa.Column("name", sa.String(length=255), nullable=False),
            sa.Column("description", sa.Text(), nullable=False),
            sa.Column("layout", sa.JSON(), nullable=False),
            sa.Column("settings", sa.JSON(), nullable=False),
            sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )

    if _MEMBER_TABLE not in tables:
        op.create_table(
            _MEMBER_TABLE,
            sa.Column("id", sa.String(length=64), primary_key=True),
            sa.Column("workbench_id", sa.String(length=64), nullable=False, index=True),
            sa.Column("definition_id", sa.String(length=64), nullable=False, index=True),
            sa.Column("order_index", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("settings", sa.JSON(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("workbench_id", "definition_id", name=_MEMBER_UNIQUE),
        )
        op.create_index(_MEMBER_ORDER_INDEX, _MEMBER_TABLE, ["workbench_id", "order_index"])


def downgrade() -> None:
    from deerflow.persistence.migrations._helpers import safe_drop_column

    insp = sa.inspect(op.get_bind())
    tables = set(insp.get_table_names())
    if _MEMBER_TABLE in tables:
        existing = {ix["name"] for ix in insp.get_indexes(_MEMBER_TABLE)}
        if _MEMBER_ORDER_INDEX in existing:
            op.drop_index(_MEMBER_ORDER_INDEX, table_name=_MEMBER_TABLE)
        op.drop_table(_MEMBER_TABLE)
    if _WORKBENCH_TABLE in tables:
        op.drop_table(_WORKBENCH_TABLE)

    run_indexes = {ix["name"] for ix in insp.get_indexes("runs")}
    if _RUN_WORKBENCH_INDEX in run_indexes:
        op.drop_index(_RUN_WORKBENCH_INDEX, table_name="runs")
    safe_drop_column("runs", "workbench_id")
