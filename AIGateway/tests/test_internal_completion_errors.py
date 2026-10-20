"""Internal chat completions: a provider failure comes back as a typed error.

EvalServer reads error.type instead of guessing from message text. The HTTP status stays
502 so callers that forward it (the Express playground) never pass a provider's 401 on as
the user's own session expiring. No live services: chat_completion is faked."""

import json
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import litellm  # noqa: E402
import pytest  # noqa: E402

import routers.completions as completions  # noqa: E402

pytestmark = pytest.mark.asyncio


def _request():
    return SimpleNamespace(headers={"x-provider-key": "sk-test"})


def _body():
    return completions.CompletionRequest(model="gemini/gemini-x", messages=[{"role": "user", "content": "hi"}])


def _raises(monkeypatch, exc):
    async def fake(**_kwargs):
        raise exc

    monkeypatch.setattr(completions, "chat_completion", fake)


async def _error(monkeypatch, exc):
    _raises(monkeypatch, exc)
    res = await completions.chat_completions(_request(), _body())
    assert res.status_code == 502
    return json.loads(res.body)["error"]


@pytest.mark.parametrize(
    "exc, error_type, status",
    [
        (litellm.AuthenticationError("bad key", "gemini", "gemini-x"), "AuthenticationError", 401),
        (litellm.NotFoundError("no such model", "gemini-x", "gemini"), "NotFoundError", 404),
        (litellm.RateLimitError("slow down", "gemini", "gemini-x"), "RateLimitError", 429),
        (litellm.ContextWindowExceededError("too long", "gemini-x", "gemini"), "ContextWindowExceededError", 400),
    ],
)
async def test_provider_error_is_typed(monkeypatch, exc, error_type, status):
    error = await _error(monkeypatch, exc)
    assert error["type"] == error_type
    assert error["status_code"] == status
    assert error["message"]


async def test_budget_error_is_typed(monkeypatch):
    error = await _error(monkeypatch, litellm.BudgetExceededError(current_cost=2.0, max_budget=1.0))
    assert error["type"] == "BudgetExceededError"


async def test_unexpected_error_is_typed_by_class_without_its_text(monkeypatch):
    error = await _error(monkeypatch, RuntimeError("boom sk-test internal detail"))
    assert error["type"] == "RuntimeError"
    assert error["status_code"] is None
    assert "boom" not in error["message"]


async def test_provider_message_never_carries_a_key(monkeypatch):
    text = (
        "bad key sk-test for https://generativelanguage.googleapis.com/v1beta/models/x"
        "?key=AIzaSyA1234567890abcdefghijklmnop&alt=sse; other sk-proj-abcdefghijkl"
    )
    error = await _error(monkeypatch, litellm.AuthenticationError(text, "gemini", "gemini-x"))
    assert "sk-test" not in error["message"]
    assert "AIzaSyA1234567890abcdefghijklmnop" not in error["message"]
    assert "sk-proj-abcdefghijkl" not in error["message"]
    assert "key=***" in error["message"]


async def test_long_message_is_clipped(monkeypatch):
    error = await _error(monkeypatch, litellm.BadRequestError("x" * 5000, "gemini-x", "gemini"))
    assert len(error["message"]) <= 500


async def test_success_is_unchanged(monkeypatch):
    async def fake(**_kwargs):
        return {"choices": [{"message": {"content": "ok"}}], "usage": {"total_tokens": 3}, "cost_usd": 0.0}

    monkeypatch.setattr(completions, "chat_completion", fake)
    res = await completions.chat_completions(_request(), _body())
    assert res["choices"][0]["message"]["content"] == "ok"
