"""Cloud model calls outside the run (report summaries, Arena) go only through the AI
Gateway; self-hosted servers are called directly. No live services."""

from __future__ import annotations

from typing import Any, Dict
from unittest.mock import MagicMock

import pytest


def test_summary_cloud_call_without_gateway_raises() -> None:
    from utils.report_summarizer import _call_llm

    with pytest.raises(RuntimeError, match="AI_GATEWAY_INTERNAL_KEY"):
        _call_llm("anthropic", "claude-haiku-4-5", "sys", "user", api_key="sk-x", endpoint_url=None)


def test_summary_cloud_call_uses_the_gateway_with_the_env_key(
    monkeypatch: pytest.MonkeyPatch, gateway_env: str
) -> None:
    from utils import report_summarizer

    seen: Dict[str, Any] = {}

    def fake(model, messages, key, **kwargs):
        seen.update(model=model, key=key)
        return "summary"

    monkeypatch.setattr(report_summarizer, "gateway_chat_completion_sync", fake)
    monkeypatch.setenv("XAI_API_KEY", "xai-env-key")

    out = report_summarizer._call_llm(
        "xai", "grok-4.20-non-reasoning", "sys", "user", api_key=None, endpoint_url=None
    )
    assert out == "summary"
    assert seen == {"model": "xai/grok-4.20-non-reasoning", "key": "xai-env-key"}


def test_summary_self_hosted_call_skips_the_gateway(monkeypatch: pytest.MonkeyPatch) -> None:
    from utils import report_summarizer

    client = MagicMock()
    client.chat.completions.create.return_value = MagicMock(
        choices=[MagicMock(message=MagicMock(content=" local "))]
    )
    monkeypatch.setattr(report_summarizer, "_self_hosted_client", lambda *_a, **_k: client)

    out = report_summarizer._call_llm(
        "ollama", "llama3", "sys", "user", api_key=None, endpoint_url="http://h:11434"
    )
    assert out == "local"


@pytest.mark.asyncio
async def test_arena_call_without_gateway_raises() -> None:
    from controllers.deepeval_arena import call_llm_model

    with pytest.raises(RuntimeError, match="AI_GATEWAY_INTERNAL_KEY"):
        await call_llm_model("openai", "gpt-4o-mini", "hi", {"openai": "sk-x"})
