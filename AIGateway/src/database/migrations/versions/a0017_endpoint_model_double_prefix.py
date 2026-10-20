"""repair endpoint models saved with a doubled provider prefix

The endpoint form put "<provider>/" in front of every model it listed, but
LiteLLM already lists most Gemini, xAI, Mistral and OpenRouter models with that
prefix. Those endpoints were saved as "gemini/gemini/gemini-2.5-flash", which
the provider rejects, so every request through them failed.

The form and the endpoint API now keep a single prefix. This migration repairs
rows saved before that: a model that starts with its provider prefix more than
once is reduced to one ("gemini/gemini/x" becomes "gemini/x"). Other models are
not touched.

Only the providers an API key can be stored for are repaired. A few real model
names do repeat the prefix ("perplexity/perplexity/sonar"); none of them belong
to these providers (checked against LiteLLM's model list).

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
    op.execute(
        """
        UPDATE ai_gateway_endpoints
        SET model = regexp_replace(model, '^(' || provider || '/)+', provider || '/')
        WHERE provider IN (
            'openai', 'anthropic', 'gemini', 'mistral',
            'xai', 'openrouter', 'together_ai', 'cohere'
        )
          AND left(model, 2 * length(provider) + 2) = provider || '/' || provider || '/'
        """
    )


def downgrade() -> None:
    pass
