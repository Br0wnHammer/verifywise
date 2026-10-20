"""Fatal error detection: typed gateway errors first, then the text patterns."""

from __future__ import annotations

import pytest

from utils.error_detection import FatalErrorTracker, detect_fatal_error
from utils.gateway_litellm_client import GatewayProviderError


@pytest.mark.parametrize(
    "error_type, status, code",
    [
        ("AuthenticationError", 401, "invalid_api_key"),
        ("PermissionDeniedError", 403, "permission_denied"),
        ("NotFoundError", 404, "model_not_found"),
        ("BudgetExceededError", 429, "budget_exceeded"),
    ],
)
def test_typed_gateway_error_is_fatal(error_type: str, status: int, code: str) -> None:
    fatal, error_code, message = detect_fatal_error(str(GatewayProviderError(error_type, status, "x")))
    assert fatal is True
    assert error_code == code
    assert message


def test_typed_error_wins_over_a_transient_word_in_the_message() -> None:
    err = GatewayProviderError("AuthenticationError", 401, "Key rejected, please try again later")
    assert detect_fatal_error(str(err))[:2] == (True, "invalid_api_key")


def test_typed_error_inside_a_wrapper_message() -> None:
    wrapped = f"Error calling judge model (google): {GatewayProviderError('NotFoundError', 404, 'gone')}"
    assert detect_fatal_error(wrapped)[:2] == (True, "model_not_found")


def test_unlisted_type_falls_through_to_the_patterns() -> None:
    quota = GatewayProviderError("RateLimitError", 429, "You exceeded your current quota: insufficient_quota")
    assert detect_fatal_error(str(quota))[:2] == (True, "insufficient_credits")
    plain = GatewayProviderError("RateLimitError", 429, "Requests are coming in too fast")
    assert detect_fatal_error(str(plain))[0] is False


def test_untyped_text_still_uses_the_patterns() -> None:
    assert detect_fatal_error("Incorrect API key provided")[:2] == (True, "invalid_api_key")
    assert detect_fatal_error("Request timeout, please retry")[0] is False


def test_tracker_stops_after_repeated_typed_errors() -> None:
    tracker = FatalErrorTracker(threshold=2)
    err = str(GatewayProviderError("NotFoundError", 404, "gone"))
    assert tracker.track_error(err) is False
    assert tracker.track_error(err) is True


@pytest.mark.parametrize(
    "text, secret",
    [
        ("https://host/v1/x?key=lowercaseonlysecret&alt=sse", "lowercaseonlysecret"),
        ("https://host/v1/x?alt=sse&key=abc123xyz", "abc123xyz"),
    ],
)
def test_key_query_parameters_are_always_redacted(text: str, secret: str) -> None:
    from utils.error_detection import redact_secrets

    assert secret not in redact_secrets(text)
