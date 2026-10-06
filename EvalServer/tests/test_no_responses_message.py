"""
Unit tests for ``build_no_responses_message``: the failure reason stored on an
experiment when no prompt produced a response. It must carry the cause (how
many prompts failed and the first provider error), not just a generic string.
"""

from __future__ import annotations

from utils.error_detection import build_no_responses_message


def test_includes_failed_count_and_first_error() -> None:
    message = build_no_responses_message(
        30, ["Model claude-sonnet-5 not available", "second error"]
    )
    assert message == (
        "No responses generated: 2/30 prompts failed. "
        "First error: Model claude-sonnet-5 not available"
    )


def test_truncates_long_first_error() -> None:
    long_error = "x" * 1000
    message = build_no_responses_message(5, [long_error] * 5)
    prefix = "No responses generated: 5/5 prompts failed. First error: "
    assert message.startswith(prefix)
    first_error = message[len(prefix):]
    assert first_error == "x" * 300 + "…"


def test_collapses_whitespace_in_first_error() -> None:
    message = build_no_responses_message(1, ["line one\n\n   line two  "])
    assert message.endswith("First error: line one line two")


def test_falls_back_to_generic_message_without_errors() -> None:
    assert build_no_responses_message(0, []) == "No responses generated"
    assert build_no_responses_message(3, []) == "No responses generated"


def test_skips_blank_errors_when_choosing_first_error() -> None:
    message = build_no_responses_message(2, ["   ", "Real cause"])
    assert message.endswith("First error: Real cause")
