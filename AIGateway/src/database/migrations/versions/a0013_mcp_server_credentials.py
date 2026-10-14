"""mcp server credentials encrypted; last discovery error

Encrypts the secrets in every MCP server's auth_config (bearer token, API
key) and renames header_name to header, using the same AES-256-GCM helper
as provider API keys. Adds last_discovery_error so a failed discovery can
say why. Idempotent: rows already in the new shape are rewritten to the
same shape.

Revision ID: a0013
Revises: a0012
Create Date: 2026-10-13
"""

import json
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from utils.mcp_credentials import legacy_config, migrate_stored_config

revision: str = "a0013"
down_revision: Union[str, None] = "a0012"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _rewrite(transform) -> None:
    conn = op.get_bind()
    rows = conn.execute(
        sa.text(
            "SELECT id, auth_type, auth_config FROM ai_gateway_mcp_servers "
            "WHERE auth_type IN ('bearer', 'api_key')"
        )
    ).mappings().all()
    for row in rows:
        cfg = row["auth_config"]
        if isinstance(cfg, str):
            cfg = json.loads(cfg or "{}")
        try:
            new_cfg = transform(row["auth_type"], cfg or {})
        except ValueError as exc:
            raise RuntimeError(
                "a0013 needs ENCRYPTION_KEY set in the AI Gateway environment to "
                f"encrypt MCP server credentials (server id {row['id']}): {exc}"
            ) from exc
        conn.execute(
            sa.text(
                "UPDATE ai_gateway_mcp_servers SET auth_config = CAST(:cfg AS jsonb) "
                "WHERE id = :id"
            ),
            {"cfg": json.dumps(new_cfg), "id": row["id"]},
        )


def upgrade() -> None:
    op.execute("SET search_path TO verifywise")
    op.execute(
        "ALTER TABLE ai_gateway_mcp_servers "
        "ADD COLUMN IF NOT EXISTS last_discovery_error TEXT NULL"
    )
    _rewrite(migrate_stored_config)


def downgrade() -> None:
    op.execute("SET search_path TO verifywise")
    _rewrite(legacy_config)
    op.execute(
        "ALTER TABLE ai_gateway_mcp_servers DROP COLUMN IF EXISTS last_discovery_error"
    )
