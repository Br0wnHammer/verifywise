"""
Tests for ModelRunner (EvaluationModule).

ModelRunner instantiation imports `transformers` at module load, but the
*setup* methods for cloud providers can be patched out so we never touch a
real client. We construct partial mock instances using ``__new__`` and then
manually populate fields, sidestepping the heavy provider SDK imports.
"""

from __future__ import annotations

from typing import Optional
from unittest.mock import MagicMock, patch

import pytest

from deepeval_engine.gateway_litellm_client import GatewayCompletion


def _make_runner(provider: str, model_name: str = "test-model", gateway_mode: bool = False):
    """Build a ModelRunner instance without running __init__."""
    from deepeval_engine.model_runner import ModelRunner

    runner = ModelRunner.__new__(ModelRunner)
    runner.model_name = model_name
    runner.provider = provider.lower()
    runner.device = "cpu"
    runner.model = None
    runner.tokenizer = None
    runner._gateway_mode = gateway_mode
    runner._gateway_api_key = "sk-fake" if gateway_mode else None
    runner.last_completion = None
    runner.dropped_params = set()
    runner.openai_client = MagicMock()
    runner.anthropic_client = MagicMock()
    runner.google_client = MagicMock()
    runner.xai_client = MagicMock()
    runner.mistral_client = MagicMock()
    runner.ollama_client = MagicMock()
    runner.openrouter_client = MagicMock()
    return runner


# --------------------------------------------------------------------------- #
# Provider dispatch table — gateway OFF                                       #
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "provider,private_method",
    [
        ("openai", "_generate_openai"),
        ("anthropic", "_generate_anthropic"),
        ("google", "_generate_google"),
        ("xai", "_generate_xai"),
        ("mistral", "_generate_mistral"),
        ("openrouter", "_generate_openrouter"),
        ("ollama", "_generate_ollama"),
        ("huggingface", "_generate_huggingface"),
    ],
)
def test_generate_dispatches_to_correct_provider(provider: str, private_method: str) -> None:
    runner = _make_runner(provider)
    with patch.object(runner, private_method, return_value="dispatched") as mocked:
        result = runner.generate("hello", max_tokens=10)
    assert result == "dispatched"
    mocked.assert_called_once()


def test_generate_unknown_provider_raises() -> None:
    runner = _make_runner("not-a-real-provider")
    runner._gateway_mode = False
    with pytest.raises(ValueError, match="Unsupported provider"):
        runner.generate("hi")


# --------------------------------------------------------------------------- #
# Gateway-mode routing — ALL cloud providers redirect to _generate_gateway     #
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "provider,model_name,expected_litellm",
    [
        ("openai", "gpt-4o", "gpt-4o"),
        ("anthropic", "claude-3", "anthropic/claude-3"),
        ("google", "gemini-1.5-pro", "gemini/gemini-1.5-pro"),
        ("xai", "grok-beta", "xai/grok-beta"),
        ("mistral", "mistral-large", "mistral/mistral-large"),
        ("openrouter", "meta-llama/llama-3.1-70b-instruct", "openrouter/meta-llama/llama-3.1-70b-instruct"),
        ("openrouter", "gpt-4o", "openrouter/gpt-4o"),
    ],
)
def test_generate_gateway_mode_uses_litellm_prefix(
    provider: str, model_name: str, expected_litellm: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner = _make_runner(provider, model_name=model_name, gateway_mode=True)

    captured = {}

    def fake_completion(litellm_model, messages, api_key, **kwargs):
        captured["litellm_model"] = litellm_model
        captured["api_key"] = api_key
        captured["messages"] = messages
        return GatewayCompletion(text="gateway response", total_tokens=11, cost_usd=0.0003)

    monkeypatch.setattr(
        "deepeval_engine.gateway_litellm_client.gateway_completion_sync",
        fake_completion,
    )

    result = runner.generate("hi", max_tokens=5, temperature=0.1)
    assert result == "gateway response"
    # The gateway's usage and cost stay on the runner for the caller to record
    assert runner.last_completion.total_tokens == 11
    assert runner.last_completion.cost_usd == 0.0003
    assert captured["litellm_model"] == expected_litellm
    assert captured["api_key"] == "sk-fake"
    assert captured["messages"] == [{"role": "user", "content": "hi"}]


def test_generate_gateway_mode_requires_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    runner = _make_runner("openai", gateway_mode=True)
    runner._gateway_api_key = ""
    with pytest.raises(RuntimeError, match="Gateway mode without API key"):
        runner.generate("hi")


# --------------------------------------------------------------------------- #
# _retry_with_backoff — rate-limit retries                                    #
# --------------------------------------------------------------------------- #


def test_retry_with_backoff_retries_on_rate_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("deepeval_engine.model_runner.time.sleep", lambda _: None)
    runner = _make_runner("openai")

    attempts = {"count": 0}

    def flaky():
        attempts["count"] += 1
        if attempts["count"] < 3:
            raise RuntimeError("Status 429: rate limit hit")
        return "ok"

    result = runner._retry_with_backoff(flaky, max_retries=3, base_delay=1)
    assert result == "ok"
    assert attempts["count"] == 3


def test_retry_with_backoff_raises_on_non_rate_limit() -> None:
    runner = _make_runner("openai")

    def boom():
        raise ValueError("not a rate limit")

    with pytest.raises(ValueError, match="not a rate limit"):
        runner._retry_with_backoff(boom, max_retries=3, base_delay=0)


def test_retry_with_backoff_exhausts_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("deepeval_engine.model_runner.time.sleep", lambda _: None)
    runner = _make_runner("openai")

    def always_rate_limit():
        raise RuntimeError("Status 429 rate limit")

    with pytest.raises(RuntimeError, match="429"):
        runner._retry_with_backoff(always_rate_limit, max_retries=2, base_delay=1)


# --------------------------------------------------------------------------- #
# Provider-specific generate paths (no real SDK calls)                        #
# --------------------------------------------------------------------------- #


def test_generate_openai_returns_content() -> None:
    runner = _make_runner("openai")
    response = MagicMock()
    response.choices = [MagicMock(message=MagicMock(content="hello world"))]
    runner.openai_client.chat.completions.create.return_value = response

    result = runner._generate_openai("prompt", max_tokens=10, temperature=0.5, top_p=None)
    assert result == "hello world"


def test_generate_openai_drops_top_p_for_o_series_models() -> None:
    runner = _make_runner("openai", model_name="o3-mini")
    response = MagicMock()
    response.choices = [MagicMock(message=MagicMock(content="resp"))]
    runner.openai_client.chat.completions.create.return_value = response

    runner._generate_openai("prompt", max_tokens=10, temperature=0.5, top_p=0.9)
    call_kwargs = runner.openai_client.chat.completions.create.call_args.kwargs
    assert "top_p" not in call_kwargs


def test_generate_openai_includes_top_p_for_normal_models() -> None:
    runner = _make_runner("openai", model_name="gpt-4o")
    response = MagicMock()
    response.choices = [MagicMock(message=MagicMock(content="resp"))]
    runner.openai_client.chat.completions.create.return_value = response

    runner._generate_openai("prompt", max_tokens=10, temperature=0.5, top_p=0.9)
    call_kwargs = runner.openai_client.chat.completions.create.call_args.kwargs
    assert call_kwargs["top_p"] == 0.9


def test_generate_openai_raises_on_empty_content() -> None:
    runner = _make_runner("openai")
    response = MagicMock()
    response.choices = [MagicMock(message=MagicMock(content=None))]
    runner.openai_client.chat.completions.create.return_value = response
    with pytest.raises(ValueError, match="empty response"):
        runner._generate_openai("p", max_tokens=10, temperature=0.5, top_p=None)


def test_generate_anthropic_extracts_text() -> None:
    runner = _make_runner("anthropic")
    block = MagicMock()
    block.text = "anthropic out"
    runner.anthropic_client.messages.create.return_value = MagicMock(content=[block])
    result = runner._generate_anthropic("prompt", max_tokens=5, temperature=0.5, top_p=None)
    assert result == "anthropic out"


def test_generate_anthropic_top_p_excludes_temperature() -> None:
    runner = _make_runner("anthropic")
    block = MagicMock()
    block.text = "ok"
    runner.anthropic_client.messages.create.return_value = MagicMock(content=[block])
    runner._generate_anthropic("p", max_tokens=5, temperature=0.5, top_p=0.9)
    kwargs = runner.anthropic_client.messages.create.call_args.kwargs
    assert "top_p" in kwargs
    assert "temperature" not in kwargs


def test_generate_google_returns_text() -> None:
    runner = _make_runner("google")
    runner.google_client.generate_content.return_value = MagicMock(text="g out")
    out = runner._generate_google("p", max_tokens=10, temperature=0.0, top_p=None)
    assert out == "g out"


def test_generate_mistral_handles_string_content() -> None:
    runner = _make_runner("mistral")
    chat_response = MagicMock()
    chat_response.choices = [MagicMock(message=MagicMock(content="m out"))]
    runner.mistral_client.chat.complete.return_value = chat_response
    out = runner._generate_mistral("p", max_tokens=5, temperature=0.0, top_p=None)
    assert out == "m out"


def test_generate_mistral_handles_list_content_with_text_blocks() -> None:
    runner = _make_runner("mistral")
    chat_response = MagicMock()
    chat_response.choices = [MagicMock(message=MagicMock(content=[{"text": "a"}, {"text": "b"}]))]
    runner.mistral_client.chat.complete.return_value = chat_response
    out = runner._generate_mistral("p", max_tokens=5, temperature=0.0, top_p=None)
    assert out == "ab"


def test_generate_ollama_returns_response() -> None:
    runner = _make_runner("ollama")
    runner.ollama_client.generate.return_value = {"response": "  ollama out  "}
    out = runner._generate_ollama("p", max_tokens=5, temperature=0.0, top_p=None)
    assert out == "ollama out"


def test_generate_openrouter_returns_content() -> None:
    runner = _make_runner("openrouter")
    response = MagicMock()
    response.choices = [MagicMock(message=MagicMock(content="or out"))]
    runner.openrouter_client.chat.completions.create.return_value = response
    out = runner._generate_openrouter("p", max_tokens=5, temperature=0.0, top_p=None)
    assert out == "or out"


def test_generate_openrouter_raises_on_empty_content() -> None:
    runner = _make_runner("openrouter")
    response = MagicMock()
    response.choices = [MagicMock(message=MagicMock(content=None))]
    runner.openrouter_client.chat.completions.create.return_value = response
    with pytest.raises(ValueError, match="empty response"):
        runner._generate_openrouter("p", max_tokens=5, temperature=0.0, top_p=None)


# --------------------------------------------------------------------------- #
# generate_batch                                                               #
# --------------------------------------------------------------------------- #


def test_generate_batch_returns_list_of_same_length(monkeypatch: pytest.MonkeyPatch) -> None:
    runner = _make_runner("openai")
    monkeypatch.setattr(runner, "generate", lambda p, *a, **kw: f"resp:{p}")
    out = runner.generate_batch(["p1", "p2", "p3"])
    assert out == ["resp:p1", "resp:p2", "resp:p3"]


def test_generate_batch_empty_input() -> None:
    runner = _make_runner("openai")
    assert runner.generate_batch([]) == []


# --------------------------------------------------------------------------- #
# _env_api_key_for_provider — provider→env var mapping                        #
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "provider,env_var,key",
    [
        ("openai", "OPENAI_API_KEY", "sk-x"),
        ("anthropic", "ANTHROPIC_API_KEY", "sk-ant-x"),
        ("google", "GOOGLE_API_KEY", "AIza-x"),
        ("gemini", "GOOGLE_API_KEY", "AIza-x"),
        ("xai", "XAI_API_KEY", "xai-x"),
        ("mistral", "MISTRAL_API_KEY", "mist-x"),
        ("openrouter", "OPENROUTER_API_KEY", "sk-or-v1-x"),
        ("huggingface", "HF_API_KEY", "hf-x"),
    ],
)
def test_env_api_key_for_provider(
    monkeypatch: pytest.MonkeyPatch, provider: str, env_var: str, key: str
) -> None:
    from deepeval_engine.model_runner import ModelRunner

    monkeypatch.setenv(env_var, key)
    assert ModelRunner._env_api_key_for_provider_static(provider) == key


def test_env_api_key_for_unknown_provider_returns_none() -> None:
    from deepeval_engine.model_runner import ModelRunner

    assert ModelRunner._env_api_key_for_provider_static("not-real") is None


def test_gateway_quota_error_is_not_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    from deepeval_engine.gateway_litellm_client import GatewayProviderError

    runner = _make_runner("openai", model_name="gpt-4o", gateway_mode=True)
    calls = {"count": 0}

    def quota(*_args, **_kwargs):
        calls["count"] += 1
        raise GatewayProviderError("RateLimitError", 429, "insufficient_quota")

    monkeypatch.setattr("deepeval_engine.gateway_litellm_client.gateway_completion_sync", quota)
    monkeypatch.setattr("deepeval_engine.model_runner.time.sleep", lambda _s: pytest.fail("slept"))

    with pytest.raises(GatewayProviderError):
        runner.generate("hi")
    assert calls["count"] == 1


def test_gateway_passing_rate_limit_is_retried_with_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    from deepeval_engine.gateway_litellm_client import GatewayCompletion, GatewayProviderError

    runner = _make_runner("openai", model_name="gpt-4o", gateway_mode=True)
    calls = {"count": 0}
    slept = []

    def flaky(*_args, **_kwargs):
        calls["count"] += 1
        if calls["count"] < 3:
            raise GatewayProviderError("RateLimitError", 429, "Rate limit reached for requests per min")
        return GatewayCompletion(text="ok")

    monkeypatch.setattr("deepeval_engine.gateway_litellm_client.gateway_completion_sync", flaky)
    monkeypatch.setattr("deepeval_engine.model_runner.time.sleep", slept.append)

    assert runner.generate("hi") == "ok"
    assert calls["count"] == 3
    assert slept == [2, 4]


@pytest.mark.parametrize(
    "message, attempt, delay",
    [
        ("Rate limit reached for requests per min", 1, 4),
        ("Quota exceeded ... per minute. Please retry in 30s", 0, 30),
        ("Quota exceeded ... per minute. Please retry in 1.5s", 2, 8),
        ("Quota exceeded ... per minute. Please retry in 300s", 0, 60),
    ],
)
def test_rate_limit_delay_uses_hint_capped_at_a_minute(message: str, attempt: int, delay: float) -> None:
    from deepeval_engine.gateway_litellm_client import GatewayProviderError
    from deepeval_engine.model_runner import _rate_limit_delay

    assert _rate_limit_delay(GatewayProviderError("RateLimitError", 429, message), attempt) == delay


@pytest.mark.parametrize(
    "message, passing",
    [
        ("Quota exceeded for metric generate_content_free_tier_requests per minute. Please retry in 30s", True),
        ("Rate limit reached for requests per min", True),
        ('Resource exhausted. "retryDelay": "12s"', True),
        ("Too many requests", True),
        ("Quota exceeded for metric generate_content_free_tier_requests per day. Please retry in 30s", False),
        ("Quota exceeded for metric generate_content_free_tier_requests", False),
        ('quotaId: "GenerateRequestsPerMinutePerProjectPerModel"', True),
        ("Quota exceeded for metric x, limit: 0, model: gemini-2.5-pro. Please retry in 30s", False),
        ("Rate limit reached on requests per day (RPD): Limit 200. Please try again in 8s", False),
        ("Insufficient credits. Please retry in 10s", False),
        (
            "You exceeded your current quota, please check your plan and billing details. "
            "Quota exceeded for metric x, limit: 10. Please retry in 43.6s",
            True,
        ),
        ("You exceeded your current quota, please check your plan and billing details. insufficient_quota", False),
        ("Your credit balance is too low", False),
    ],
)
def test_passing_rate_limit_rule(message: str, passing: bool) -> None:
    from deepeval_engine.gateway_litellm_client import GatewayProviderError
    from deepeval_engine.model_runner import _is_passing_rate_limit

    assert _is_passing_rate_limit(GatewayProviderError("RateLimitError", 429, message)) is passing


def test_gateway_retries_stop_at_the_wait_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    from deepeval_engine.gateway_litellm_client import GatewayProviderError

    runner = _make_runner("google", model_name="gemini-3.8-flash", gateway_mode=True)
    slept = []

    def limited(*_args, **_kwargs):
        raise GatewayProviderError("RateLimitError", 429, "Quota exceeded ... per minute. Please retry in 40s")

    monkeypatch.setattr("deepeval_engine.gateway_litellm_client.gateway_completion_sync", limited)
    monkeypatch.setattr("deepeval_engine.model_runner.time.sleep", slept.append)

    with pytest.raises(GatewayProviderError):
        runner.generate("hi")
    # 40 + 40 fits the 90 s budget; a third 40 s wait would not
    assert slept == [40, 40]


def test_gateway_forwards_top_p_and_collects_dropped_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    from deepeval_engine.gateway_litellm_client import GatewayCompletion

    runner = _make_runner("openai", model_name="o3-mini", gateway_mode=True)
    seen = {}

    def fake(_model, _messages, _key, **kwargs):
        seen.update(kwargs)
        return GatewayCompletion(text="ok", dropped_params=["temperature", "top_p"])

    monkeypatch.setattr("deepeval_engine.gateway_litellm_client.gateway_completion_sync", fake)

    assert runner.generate("hi", temperature=0.7, top_p=0.5) == "ok"
    assert seen["top_p"] == 0.5
    assert runner.dropped_params == {"temperature", "top_p"}
