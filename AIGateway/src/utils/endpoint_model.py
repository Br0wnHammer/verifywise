"""Endpoint model names in LiteLLM form ("<provider>/<model>")."""

from typing import Optional

import litellm


def normalize_endpoint_model(provider: Optional[str], model: Optional[str]) -> Optional[str]:
    """Collapse a repeated provider prefix: "gemini/gemini/x" becomes "gemini/x".

    LiteLLM lists many models with their provider prefix already, and the
    endpoint form used to add it again. Only the providers an API key can be
    stored for are repaired (the same set migration a0017 repairs); none of
    them has a real model whose name repeats the prefix. A name LiteLLM knows
    is kept as it is. Everything else is returned unchanged.
    """
    # Imported here: routers import this module, so a top-level import of a
    # router from it would tie the two together at load time.
    from routers.api_keys import VALID_PROVIDERS

    if (
        not isinstance(provider, str)
        or not isinstance(model, str)
        or provider not in VALID_PROVIDERS
        or model in litellm.model_cost
    ):
        return model
    prefix = f"{provider}/"
    while model.startswith(prefix + prefix):
        model = model[len(prefix):]
    return model
