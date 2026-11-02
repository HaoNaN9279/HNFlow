"""human task kind + workflow undo records.

Revision ID: 0019_human_task_kind_and_undo
Revises: 0018_scheduled_task_triggers
Create Date: 2026-10-14

Two additive changes for N10 (dev plan §21):

- ``human_tasks.kind`` distinguishes an ordinary ``human:task`` from the
  approval task an irreversible node suspends on (``"approval"``).  Defaulting
  to ``"task"`` keeps every existing row and every pre-N10 code path
  byte-identical.
- ``workflow_undo_records`` stores what an irreversible node did, so a failed
  node can roll back its own side effects and a finished run can be undone
  through ``POST /api/workflows/{id}/runs/{run_id}/undo``.  Records are
  best-effort (like the N6 instance records): a write failure never fails the
  node.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0019_human_task_kind_and_undo"
down_revision: str | Sequence[str] | None = "0018_scheduled_task_triggers"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_UNDO_TABLE = "workflow_undo_records"
_UNDO_RUN_INDEX = "ix_workflow_undo_records_run_id"


def upgrade() -> None:
    from deerflow.persistence.migrations._helpers import safe_add_column

    safe_add_column("human_tasks", sa.Column("kind", sa.String(length=32), nullable=False, server_default=sa.text("'task'")))

    # Idempotent: the empty/legacy bootstrap path runs ``create_all`` (which
    # builds the table from the ORM metadata) before ``upgrade head``.
    insp = sa.inspect(op.get_bind())
    if _UNDO_TABLE not in set(insp.get_table_names()):
        op.create_table(
            _UNDO_TABLE,
            sa.Column("id", sa.String(length=64), primary_key=True),
            sa.Column("user_id", sa.String(length=64), nullable=False, index=True),
            sa.Column("run_id", sa.String(length=64), nullable=False),
            sa.Column("node_id", sa.String(length=64), nullable=False),
            sa.Column("kind", sa.String(length=32), nullable=False),
            sa.Column("status", sa.String(length=32), nullable=False),
            sa.Column("targets", sa.JSON(), nullable=False),
            sa.Column("backup_paths", sa.JSON(), nullable=False),
            sa.Column("session_id", sa.String(length=64), nullable=True),
            sa.Column("app_steps", sa.Integer(), nullable=True),
            sa.Column("detail", sa.String(length=512), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index(_UNDO_RUN_INDEX, _UNDO_TABLE, ["run_id"])


def downgrade() -> None:
    from deerflow.persistence.migrations._helpers import safe_drop_column

    insp = sa.inspect(op.get_bind())
    if _UNDO_TABLE in set(insp.get_table_names()):
        existing = {ix["name"] for ix in insp.get_indexes(_UNDO_TABLE)}
        if _UNDO_RUN_INDEX in existing:
            op.drop_index(_UNDO_RUN_INDEX, table_name=_UNDO_TABLE)
        op.drop_table(_UNDO_TABLE)

    safe_drop_column("human_tasks", "kind")
