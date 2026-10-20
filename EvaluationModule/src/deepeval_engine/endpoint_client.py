"""
Clients for user-entered model endpoints (custom_api models, self-hosted and Ollama
judges, scorers and report summaries). Each URL has passed assert_safe_outbound_url
first; these clients never follow redirects, so an allowed host cannot bounce the
request on to a refused one (cloud metadata, a wildcard address).
"""

from typing import Optional


def openai_compatible_client(base_url: str, api_key: Optional[str] = None):
    """An OpenAI SDK client for base_url. Self-hosted servers often take no key, but the
    client requires one."""
    from openai import DefaultHttpxClient, OpenAI

    return OpenAI(
        api_key=api_key or "not-needed",
        base_url=base_url,
        http_client=DefaultHttpxClient(follow_redirects=False),
    )


def ollama_client():
    """An Ollama client for OLLAMA_HOST (checked by run_evaluation before it is set)."""
    import ollama

    return ollama.Client(follow_redirects=False)
