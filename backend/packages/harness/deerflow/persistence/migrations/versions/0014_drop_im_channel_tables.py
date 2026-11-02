"""drop IM channel + webhook dedupe tables.

HNFlow is a single-machine workflow engine; the upstream IM channel layer
(Feishu / Slack / Telegram / Discord / DingTalk / WeChat / WeCom / Buzz and the
GitHub webhook channel) is removed. The published baseline revision
``0001_baseline`` keeps its ``create_table`` calls (never edit a released
revision), so existing databases carry the ``channel_*`` and
``webhook_deliveries`` tables. This revision drops them.

Idempotent by construction: the tables may not exist (fresh DBs where
``create_all`` never created them, or partial upgrades), so each drop is
guarded by the inspector.

Revision ID: 0014_drop_im_channel_tables
Revises: 0013_human_tasks
Create Date: 2026-10-13
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0014_drop_im_channel_tables"
down_revision: str | Sequence[str] | None = "0013_human_tasks"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Drop order matters for SQLite FK enforcement: child tables before the parent
# ``channel_connections`` row they reference.
_CHANNEL_TABLES_IN_DROP_ORDER: tuple[str, ...] = (
    "channel_conversations",
    "channel_credentials",
    "channel_oauth_states",
    "channel_connections",
    "webhook_deliveries",
)


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    for table_name in _CHANNEL_TABLES_IN_DROP_ORDER:
        if inspector.has_table(table_name):
            op.drop_table(table_name)


def downgrade() -> None:
    # The IM channel layer is gone; recreating its schema would not restore a
    # usable feature. Downgrade is intentionally a no-op.
    pass
