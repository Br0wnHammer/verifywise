"""Self-contained tests for running guardrail scans off the event loop.

scan_text_async runs scan_text on one dedicated thread, so a slow scan never
blocks the event loop and two scans never use the shared engine at once.
Presidio is mocked; no spaCy model is loaded. No live services."""

import ast
import asyncio
import os
import sys
import threading
import time

import pytest
from types import SimpleNamespace

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import services.guardrail_service as gs  # noqa: E402
import services.presidio_engine as presidio_engine  # noqa: E402

KEYWORD_BLOCK = {
    "id": 1, "guardrail_type": "content_filter", "name": "Project codename",
    "config": {"type": "keyword", "pattern": "bluebird"}, "scope": "input", "action": "block", "is_active": True,
}
REGEX_MASK = {
    "id": 2, "guardrail_type": "content_filter", "name": "Ticket ids",
    "config": {"type": "regex", "pattern": r"TCK-\d+"}, "scope": "input", "action": "mask", "is_active": True,
}


@pytest.fixture(autouse=True)
def fresh_executor():
    """Each test gets its own scan thread, fully stopped afterwards."""
    gs.shutdown_scan_executor()
    yield
    executor = gs._scan_executor
    gs.shutdown_scan_executor()
    if executor is not None:
        executor.shutdown(wait=True)


@pytest.mark.parametrize(
    "text, rules",
    [
        ("Ship bluebird on Friday", [KEYWORD_BLOCK]),
        ("See TCK-123 and TCK-456", [REGEX_MASK]),
        ("Nothing to see here", [KEYWORD_BLOCK, REGEX_MASK]),
        ("", [KEYWORD_BLOCK]),
        ("Some text", []),
    ],
)
async def test_async_wrapper_returns_the_same_result_as_scan_text(text, rules):
    expected = gs.scan_text(text=text, guardrail_rules=rules, settings={})
    actual = await gs.scan_text_async(text=text, guardrail_rules=rules, settings={})
    assert actual.blocked == expected.blocked
    assert actual.block_reason == expected.block_reason
    assert actual.masked_text == expected.masked_text
    assert actual.detections == expected.detections


async def test_scan_runs_on_the_dedicated_thread(monkeypatch):
    seen = {}

    def fake_scan(text, guardrail_rules, settings):
        seen["thread"] = threading.current_thread().name
        seen["args"] = (text, guardrail_rules, settings)
        return gs.ScanResult()

    monkeypatch.setattr(gs, "scan_text", fake_scan)
    await gs.scan_text_async(text="hi", guardrail_rules=[KEYWORD_BLOCK], settings={"a": 1})

    assert seen["thread"].startswith(gs.SCAN_THREAD_PREFIX)
    assert seen["thread"] != threading.current_thread().name
    assert seen["args"] == ("hi", [KEYWORD_BLOCK], {"a": 1})


async def test_event_loop_stays_free_during_a_slow_scan(monkeypatch):
    order = []

    def slow_scan(**_kw):
        time.sleep(0.3)
        order.append("scan")
        return gs.ScanResult()

    async def other_request():
        await asyncio.sleep(0.01)
        order.append("other")

    monkeypatch.setattr(gs, "scan_text", slow_scan)
    await asyncio.gather(
        gs.scan_text_async(text="x", guardrail_rules=[KEYWORD_BLOCK], settings={}),
        other_request(),
    )
    assert order == ["other", "scan"]


async def test_concurrent_scans_never_overlap(monkeypatch):
    lock = threading.Lock()
    state = {"running": 0, "max": 0, "threads": set()}

    def fake_scan(**_kw):
        with lock:
            state["running"] += 1
            state["max"] = max(state["max"], state["running"])
            state["threads"].add(threading.current_thread().name)
        time.sleep(0.05)
        with lock:
            state["running"] -= 1
        return gs.ScanResult()

    monkeypatch.setattr(gs, "scan_text", fake_scan)
    await asyncio.gather(*[
        gs.scan_text_async(text=str(i), guardrail_rules=[KEYWORD_BLOCK], settings={}) for i in range(5)
    ])
    assert state["max"] == 1
    assert len(state["threads"]) == 1


@pytest.fixture
def engine(monkeypatch):
    """A mocked Presidio: installed, model present, not loaded yet."""
    state = {"loads": [], "available": True, "missing": []}
    monkeypatch.setattr(presidio_engine, "_initialized", False)
    monkeypatch.setattr(presidio_engine, "is_available", lambda: state["available"])
    monkeypatch.setattr(presidio_engine, "_missing_spacy_models", lambda: state["missing"])
    monkeypatch.setattr(
        presidio_engine, "_ensure_initialized", lambda: state["loads"].append(threading.current_thread().name)
    )
    return state


def test_preload_loads_the_engine_on_the_scan_thread(engine):
    gs.preload_pii_engine().result(timeout=5)
    assert len(engine["loads"]) == 1
    assert engine["loads"][0].startswith(gs.SCAN_THREAD_PREFIX)


def test_preload_failure_is_logged_not_raised(monkeypatch, engine, caplog):
    def broken():
        raise RuntimeError("model broken")

    monkeypatch.setattr(presidio_engine, "_ensure_initialized", broken)
    gs.preload_pii_engine().result(timeout=5)
    assert "PII engine preload failed: model broken" in caplog.text


def test_preload_skips_when_presidio_is_missing(engine):
    engine["available"] = False
    assert presidio_engine.warm_up() is False
    assert engine["loads"] == []


def test_preload_never_downloads_a_missing_spacy_model(engine):
    engine["missing"] = ["en_core_web_lg"]
    assert presidio_engine.warm_up() is False
    assert engine["loads"] == []


def test_preload_is_a_no_op_once_loaded(monkeypatch, engine):
    monkeypatch.setattr(presidio_engine, "_initialized", True)
    assert presidio_engine.warm_up() is True
    assert engine["loads"] == []


async def test_nothing_to_scan_does_not_queue_behind_other_scans(monkeypatch):
    def must_not_run(**_kw):
        raise AssertionError("scan_text should not be called")

    monkeypatch.setattr(gs, "scan_text", must_not_run)
    gs.get_scan_executor().submit(time.sleep, 1)
    t = time.monotonic()
    assert (await gs.scan_text_async(text="hi", guardrail_rules=[], settings={})).detections == []
    assert (await gs.scan_text_async(text="", guardrail_rules=[KEYWORD_BLOCK], settings={})).detections == []
    assert time.monotonic() - t < 0.5


def test_shutdown_stops_the_thread_and_a_later_scan_starts_a_new_one():
    first = gs.get_scan_executor()
    gs.shutdown_scan_executor()
    assert gs._scan_executor is None
    second = gs.get_scan_executor()
    assert second is not first
    assert second.submit(lambda: 42).result(timeout=5) == 42


@pytest.mark.parametrize("enabled", [True, False])
def test_app_startup_preloads_only_when_enabled_and_shutdown_stops_the_thread(monkeypatch, enabled):
    from fastapi.testclient import TestClient

    import app as gateway_app

    calls = []
    monkeypatch.setattr(gateway_app.settings, "guardrails_preload_pii", enabled)
    monkeypatch.setattr(gateway_app, "preload_pii_engine", lambda: calls.append("preload"))
    monkeypatch.setattr(gateway_app, "shutdown_scan_executor", lambda: calls.append("shutdown"))

    with TestClient(gateway_app.app) as client:
        assert client.get("/health").status_code == 200
        assert calls == (["preload"] if enabled else [])
    assert calls[-1] == "shutdown"


def test_app_startup_survives_a_preload_that_cannot_start(monkeypatch):
    from fastapi.testclient import TestClient

    import app as gateway_app

    def broken():
        raise RuntimeError("cannot start thread")

    monkeypatch.setattr(gateway_app.settings, "guardrails_preload_pii", True)
    monkeypatch.setattr(gateway_app, "preload_pii_engine", broken)
    monkeypatch.setattr(gateway_app, "shutdown_scan_executor", lambda: None)

    with TestClient(gateway_app.app) as client:
        assert client.get("/health").status_code == 200


def test_preload_checks_the_pinned_spacy_model(monkeypatch):
    import spacy.util

    asked = []
    monkeypatch.setattr(spacy.util, "is_package", lambda name: asked.append(name) or False)
    assert presidio_engine._missing_spacy_models() == [presidio_engine.SPACY_MODEL]
    assert asked == ["en_core_web_md"]


async def test_scan_thread_sees_the_request_context(monkeypatch):
    import contextvars

    request_id = contextvars.ContextVar("request_id_test", default=None)
    seen = {}

    def fake_scan(**_kw):
        seen["request_id"] = request_id.get()
        return gs.ScanResult()

    monkeypatch.setattr(gs, "scan_text", fake_scan)
    request_id.set("req-42")
    await gs.scan_text_async(text="hi", guardrail_rules=[KEYWORD_BLOCK], settings={})
    assert seen["request_id"] == "req-42"


class _FakeProvider:
    """Stands in for presidio's NlpEngineProvider: the default config, or the one passed in."""

    built_with: list = []

    def __init__(self, nlp_configuration=None):
        self.nlp_configuration = nlp_configuration or {
            "nlp_engine_name": "spacy",
            "models": [{"lang_code": "en", "model_name": "en_core_web_lg"},
                       {"lang_code": "es", "model_name": "es_core_news_md"}],
            "ner_model_configuration": {"labels_to_ignore": ["ORGANIZATION"]},
        }
        if nlp_configuration is not None:
            _FakeProvider.built_with.append(nlp_configuration)

    def create_engine(self):
        return object()


def test_engine_is_built_from_the_default_config_with_only_english_md(monkeypatch):
    import presidio_analyzer
    import presidio_analyzer.nlp_engine as nlp_engine_module

    _FakeProvider.built_with = []
    monkeypatch.setattr(nlp_engine_module, "NlpEngineProvider", _FakeProvider)
    monkeypatch.setattr(presidio_analyzer, "AnalyzerEngine", lambda **_kw: type("A", (), {"registry": type("R", (), {"add_recognizer": lambda *_: None})()})())
    monkeypatch.setattr(presidio_engine, "_initialized", False)
    monkeypatch.setattr(presidio_engine, "_analyzer", None)
    monkeypatch.setattr(presidio_engine, "_anonymizer", None)
    presidio_engine._ensure_initialized()
    assert _FakeProvider.built_with == [{
        "nlp_engine_name": "spacy",
        "models": [{"lang_code": "en", "model_name": "en_core_web_md"}],
        "ner_model_configuration": {"labels_to_ignore": ["ORGANIZATION"]},
    }]


@pytest.mark.parametrize(
    "default",
    [
        {"nlp_engine_name": "transformers", "models": [{"lang_code": "en", "model_name": "en_core_web_lg"}]},
        {"nlp_engine_name": "spacy", "models": [{"lang_code": "es", "model_name": "es_core_news_md"}]},
        {"nlp_engine_name": "spacy", "models": [{"lang_code": "en", "model_name": "a"}, {"lang_code": "en", "model_name": "b"}]},
        {"nlp_engine_name": "spacy", "models": [{"lang_code": "en", "model_name": {"spacy": "x", "transformers": "y"}}]},
        {"nlp_engine_name": "spacy", "models": [{"lang_code": "en", "model_name": "en_core_web_lg"}, None]},
    ],
)
def test_an_unexpected_default_config_shape_raises(monkeypatch, default):
    import presidio_analyzer.nlp_engine as nlp_engine_module

    monkeypatch.setattr(nlp_engine_module, "NlpEngineProvider", lambda: SimpleNamespace(nlp_configuration=default))
    with pytest.raises(RuntimeError, match="changed shape"):
        presidio_engine.nlp_configuration()


def test_no_coroutine_calls_the_blocking_scan_text():
    # Async code must use scan_text_async; a direct scan_text call inside an
    # `async def` runs Presidio on the event loop (and on a second thread's
    # engine). A merge brought one in once, so this checks the whole tree.
    src = os.path.join(os.path.dirname(__file__), "..", "src")
    offenders = []
    for root, _dirs, files in os.walk(src):
        for name in files:
            if not name.endswith(".py"):
                continue
            path = os.path.join(root, name)
            with open(path, encoding="utf-8") as f:
                tree = ast.parse(f.read(), path)
            for fn in ast.walk(tree):
                if not isinstance(fn, ast.AsyncFunctionDef):
                    continue
                for node in ast.walk(fn):
                    if isinstance(node, ast.Call):
                        callee = node.func
                        called = callee.attr if isinstance(callee, ast.Attribute) else getattr(callee, "id", None)
                        if called == "scan_text":
                            offenders.append(f"{os.path.relpath(path, src)}:{node.lineno} in {fn.name}")
    assert offenders == []
