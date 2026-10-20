"""repair endpoint models saved with a doubled provider prefix

The endpoint form put "<provider>/" in front of every model it listed, but
LiteLLM already lists most Gemini, xAI, Mistral and OpenRouter models with that
prefix. Those endpoints were saved as "gemini/gemini/gemini-2.5-flash", which
the provider rejects, so every request through them failed.

The form and the endpoint API now keep a single prefix. This migration repairs
data saved before that. A model that starts with its provider prefix more than
once is reduced to one ("gemini/gemini/x" becomes "gemini/x"):

- ai_gateway_endpoints.model. Each repaired endpoint gets a change-history row
  (field "model", old and new value, no user: the migration made the change).
- ai_gateway_virtual_keys.allowed_models and blocked_models. An admin may have
  copied the doubled name from the endpoints list; virtual key access rules
  compare these entries with the endpoint's model, so they are repaired the
  same way or a block would stop matching. Order and NULLs are kept.

Only the providers an API key can be stored for are repaired, the same set
normalize_endpoint_model uses. A few real model names do repeat the prefix
("perplexity/perplexity/sonar"); none of them belong to these providers
(checked against LiteLLM's model list).

There is no downgrade: the doubled names never worked, so there is nothing to
restore.

Revision ID: a0017
Revises: a0016
Create Date: 2026-10-19
"""

from typing import Sequence, Union

from alembic import op

revision: str = "a0017"
down_revision: Union[str, None] = "a0016"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

def upgrade() -> None:
    op.execute("SET search_path TO verifywise")

    # The provider list is VALID_PROVIDERS in routers/api_keys.py when this
    # migration was written, frozen here on purpose.
    op.execute(
        """
        WITH repaired AS (
            SELECT id, organization_id, model AS old_model,
                   regexp_replace(model, '^(' || provider || '/)+', provider || '/') AS new_model
            FROM ai_gateway_endpoints
            WHERE provider IN ('openai', 'anthropic', 'gemini', 'mistral', 'xai', 'openrouter', 'together_ai', 'cohere')
              AND left(model, 2 * length(provider) + 2) = provider || '/' || provider || '/'
        ),
        updated AS (
            UPDATE ai_gateway_endpoints e
            SET model = r.new_model
            FROM repaired r
            WHERE e.id = r.id
            RETURNING e.id
        )
        INSERT INTO ai_gateway_endpoint_change_history
            (organization_id, endpoint_id, action, field_name, old_value, new_value, changed_by_user_id)
        SELECT r.organization_id, r.id, 'updated', 'model', r.old_model, r.new_model, NULL
        FROM repaired r
        JOIN updated u ON u.id = r.id
        """
    )

    # Same repair for virtual key access lists, keeping entry order
    op.execute(
        r"""
        UPDATE ai_gateway_virtual_keys
        SET allowed_models = ARRAY(
            SELECT regexp_replace(m, '^(openai|anthropic|gemini|mistral|xai|openrouter|together_ai|cohere)/(\1/)+', '\1/')
            FROM unnest(allowed_models) WITH ORDINALITY AS t(m, n)
            ORDER BY n
        )
        WHERE allowed_models IS NOT NULL
          AND EXISTS (
              SELECT 1 FROM unnest(allowed_models) AS m
              WHERE m ~ '^(openai|anthropic|gemini|mistral|xai|openrouter|together_ai|cohere)/(\1/)+'
          )
        """
    )
    op.execute(
        r"""
        UPDATE ai_gateway_virtual_keys
        SET blocked_models = ARRAY(
            SELECT regexp_replace(m, '^(openai|anthropic|gemini|mistral|xai|openrouter|together_ai|cohere)/(\1/)+', '\1/')
            FROM unnest(blocked_models) WITH ORDINALITY AS t(m, n)
            ORDER BY n
        )
        WHERE blocked_models IS NOT NULL
          AND EXISTS (
              SELECT 1 FROM unnest(blocked_models) AS m
              WHERE m ~ '^(openai|anthropic|gemini|mistral|xai|openrouter|together_ai|cohere)/(\1/)+'
          )
        """
    )


def downgrade() -> None:
    pass
