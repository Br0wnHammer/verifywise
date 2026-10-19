"""
Tests for to_stored_score: Bias, Toxicity and Hallucination are stored lower is better.

GEvalLikeMetric (non-OpenAI judges) scores them 1.0 for a clean answer, so they
are inverted. DeepEval's native BiasMetric and ToxicityMetric (OpenAI judges)
already score 0 for a clean answer and must not be inverted.
"""

from __future__ import annotations

import pytest


@pytest.fixture
def evaluator_module():
    from deepeval_engine import deepeval_evaluator

    return deepeval_evaluator


def _geval_metric(module):
    # Skip __init__: it reads judge settings this test doesn't need.
    return object.__new__(module.GEvalLikeMetric)


@pytest.mark.parametrize("name", ["Bias", "Toxicity", "Hallucination"])
def test_geval_lower_is_better_metric_is_inverted(evaluator_module, name):
    metric = _geval_metric(evaluator_module)
    assert evaluator_module.to_stored_score(name, metric, 1.0) == 0.0
    assert evaluator_module.to_stored_score(name, metric, 0.25) == pytest.approx(0.75)


@pytest.mark.parametrize(
    "name, metric_class", [("Bias", "BiasMetric"), ("Toxicity", "ToxicityMetric")]
)
def test_native_deepeval_metric_is_stored_as_is(evaluator_module, name, metric_class):
    metric = object.__new__(getattr(evaluator_module, metric_class))
    assert evaluator_module.to_stored_score(name, metric, 0.0) == 0.0
    assert evaluator_module.to_stored_score(name, metric, 0.8) == 0.8


def test_higher_is_better_metric_is_never_inverted(evaluator_module):
    metric = _geval_metric(evaluator_module)
    assert evaluator_module.to_stored_score("Correctness", metric, 0.9) == 0.9


def test_missing_score_stays_missing(evaluator_module):
    metric = _geval_metric(evaluator_module)
    assert evaluator_module.to_stored_score("Bias", metric, None) is None
