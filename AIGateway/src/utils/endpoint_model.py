"""Endpoint model names in LiteLLM form ("<provider>/<model>")."""

from typing import Optional

import litellm


def normalize_endpoint_model(provider: Optional[str], model: Optional[str]) -> Optional[str]:
    """Collapse a repeated provider prefix: "gemini/gemini/x" becomes "gemini/x".

    LiteLLM lists many models with their provider prefix already, and the
    endpoint form used to add it again. Only the providers an API key can be
    stored for are repaired (the same set migration a0017 repairs).
    Collapsing stops at a name LiteLLM knows. OpenRouter model ids are
    "<vendor>/<model>" and "openrouter" is itself a vendor
    ("openrouter/openrouter/auto"), so an OpenRouter name is never cut below
    three parts. Everything else is returned unchanged.
    """
    # Imported here: routers import this module, so a top-level import of a
    # router from it would tie the two together at load time.
    from routers.api_keys import VALID_PROVIDERS

    if (
        not isinstance(provider, str)
        or not isinstance(model, str)
        or provider not in VALID_PROVIDERS
    ):
        return model
    prefix = f"{provider}/"
    while model.startswith(prefix + prefix) and model not in litellm.model_cost:
        shorter = model[len(prefix):]
        if provider == "openrouter" and shorter.count("/") < 2:
            break
        model = shorter
    return model
