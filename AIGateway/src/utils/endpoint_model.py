"""Endpoint model names in LiteLLM form ("<provider>/<model>")."""

from typing import Optional


def normalize_endpoint_model(provider: Optional[str], model: Optional[str]) -> Optional[str]:
    """Collapse a repeated provider prefix: "gemini/gemini/x" becomes "gemini/x".

    LiteLLM lists many models with their provider prefix already, and the
    endpoint form used to add it again. A doubled prefix is never a valid model
    name, so it is reduced to one. Everything else is returned unchanged.
    """
    if not provider or not model:
        return model
    prefix = f"{provider}/"
    while model.startswith(prefix + prefix):
        model = model[len(prefix):]
    return model
