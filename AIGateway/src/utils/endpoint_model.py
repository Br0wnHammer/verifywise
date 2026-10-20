"""Endpoint model names in LiteLLM form ("<provider>/<model>")."""

from typing import Optional

import litellm


def normalize_endpoint_model(provider: Optional[str], model: Optional[str]) -> Optional[str]:
    """Collapse a repeated provider prefix: "gemini/gemini/x" becomes "gemini/x".

    LiteLLM lists many models with their provider prefix already, and the
    endpoint form used to add it again. A few real model names do repeat the
    prefix ("perplexity/perplexity/sonar"), so a name LiteLLM knows is kept
    as it is. Everything else is returned unchanged.
    """
    if not provider or not model or model in litellm.model_cost:
        return model
    prefix = f"{provider}/"
    while model.startswith(prefix + prefix):
        model = model[len(prefix):]
    return model
