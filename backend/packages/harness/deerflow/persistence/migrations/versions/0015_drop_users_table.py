"""drop users table.

HNFlow is a single-user, local workflow engine; the upstream multi-user auth
layer (OIDC / JWT / sessions / RBAC) is removed. The published baseline
revision ``0001_baseline`` keeps its ``create_table`` call (never edit a
released revision), so existing databases carry the ``users`` table. This
revision drops it.

Idempotent by construction: the table may not exist (fresh DBs where
``create_all`` never created it, or partial upgrades), so the drop is guarded
by the inspector.

Revision ID: 0015_drop_users_table
Revises: 0014_drop_im_channel_tables
Create Date: 2026-10-13
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0015_drop_users_table"
down_revision: str | Sequence[str] | None = "0014_drop_im_channel_tables"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table("users"):
        op.drop_table("users")


def downgrade() -> None:
    # The multi-user auth layer is gone; recreating its schema would not
    # restore a usable feature. Downgrade is intentionally a no-op.
    pass
