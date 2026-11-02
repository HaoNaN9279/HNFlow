"""scheduled task triggers (target, payload mapping, dedupe, retry).

Revision ID: 0018_scheduled_task_triggers
Revises: 0017_app_instances
Create Date: 2026-10-14
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0018_scheduled_task_triggers"
down_revision: str | Sequence[str] | None = "0017_app_instances"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_DEDUPE_INDEX = "uq_scheduled_task_run_dedupe"


def upgrade() -> None:
    from deerflow.persistence.migrations._helpers import safe_add_column

    # Dispatch target (N7). Defaults keep existing rows byte-identical in
    # behavior: an ``agent`` target with a 1-attempt budget and no payload.
    safe_add_column("scheduled_tasks", sa.Column("target_kind", sa.String(length=16), nullable=False, server_default=sa.text("'agent'")))
    safe_add_column("scheduled_tasks", sa.Column("target_definition_id", sa.String(length=64), nullable=True))
    safe_add_column("scheduled_tasks", sa.Column("payload_template", sa.JSON(), nullable=False, server_default=sa.text("'{}'")))
    safe_add_column("scheduled_tasks", sa.Column("max_attempts", sa.Integer(), nullable=False, server_default=sa.text("1")))
    safe_add_column("scheduled_tasks", sa.Column("attempt", sa.Integer(), nullable=False, server_default=sa.text("0")))
    # Trigger idempotency + retry observability on the run rows.
    safe_add_column("scheduled_task_runs", sa.Column("dedupe_key", sa.String(length=128), nullable=True))
    safe_add_column("scheduled_task_runs", sa.Column("attempt", sa.Integer(), nullable=False, server_default=sa.text("1")))

    # Idempotent index creation: the empty/legacy bootstrap path runs
    # ``create_all`` (which builds this index from the ORM ``__table_args__``)
    # before ``upgrade head``, so the migration must not fail when it exists.
    insp = sa.inspect(op.get_bind())
    existing = {ix["name"] for ix in insp.get_indexes("scheduled_task_runs")}
    if _DEDUPE_INDEX not in existing:
        with op.batch_alter_table("scheduled_task_runs", schema=None) as batch_op:
            batch_op.create_index(
                _DEDUPE_INDEX,
                ["task_id", "dedupe_key"],
                unique=True,
                sqlite_where=sa.text("dedupe_key IS NOT NULL"),
                postgresql_where=sa.text("dedupe_key IS NOT NULL"),
            )


def downgrade() -> None:
    from deerflow.persistence.migrations._helpers import safe_drop_column

    bind = op.get_bind()
    insp = sa.inspect(bind)
    existing = {ix["name"] for ix in insp.get_indexes("scheduled_task_runs")}
    if _DEDUPE_INDEX in existing:
        with op.batch_alter_table("scheduled_task_runs", schema=None) as batch_op:
            batch_op.drop_index(_DEDUPE_INDEX)

    for table, column in (
        ("scheduled_task_runs", "attempt"),
        ("scheduled_task_runs", "dedupe_key"),
        ("scheduled_tasks", "attempt"),
        ("scheduled_tasks", "max_attempts"),
        ("scheduled_tasks", "payload_template"),
        ("scheduled_tasks", "target_definition_id"),
        ("scheduled_tasks", "target_kind"),
    ):
        safe_drop_column(table, column)
