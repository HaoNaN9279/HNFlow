"""drop feedback table.

HNFlow is a single-user, local workflow engine; the upstream product/ops
feature set (thumbs-up/down feedback on runs) is removed. The published
baseline revision ``0001_baseline`` keeps its ``create_table`` call (never edit
a released revision), so existing databases carry the ``feedback`` table. This
revision drops it.

Idempotent by construction: the table may not exist on fresh DBs where
``create_all`` never created it (the ORM model is gone), so the drop is guarded
by the inspector.

Revision ID: 0016_drop_feedback_table
Revises: 0015_drop_users_table
Create Date: 2026-10-13
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0016_drop_feedback_table"
down_revision: str | Sequence[str] | None = "0015_drop_users_table"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table("feedback"):
        op.drop_table("feedback")


def downgrade() -> None:
    # The feedback feature is gone; recreating its schema would not restore a
    # usable feature. Downgrade is intentionally a no-op.
    pass
