"""Presidio loads once, and never publishes an engine without its custom
recognizers, even when scans start on several threads at once. No live services."""

import os
import sys
import threading
import time
import types

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import services.presidio_engine as engine  # noqa: E402


def test_concurrent_first_scans_load_the_engine_once(monkeypatch):
    built = []

    class Registry:
        def __init__(self):
            self.recognizers = []

        def add_recognizer(self, r):
            time.sleep(0.01)  # widen the window a racing reader could see
            self.recognizers.append(r)

    class FakeAnalyzer:
        def __init__(self):
            time.sleep(0.05)
            self.registry = Registry()
            built.append(self)

    class FakeRecognizer:
        def __init__(self, supported_entity, name, patterns, supported_language):
            self.name = name

    fake_analyzer_mod = types.SimpleNamespace(
        AnalyzerEngine=FakeAnalyzer, Pattern=lambda **kw: kw, PatternRecognizer=FakeRecognizer,
    )
    fake_anonymizer_mod = types.SimpleNamespace(AnonymizerEngine=lambda: object())
    monkeypatch.setitem(sys.modules, "presidio_analyzer", fake_analyzer_mod)
    monkeypatch.setitem(sys.modules, "presidio_anonymizer", fake_anonymizer_mod)
    monkeypatch.setattr(engine, "_analyzer", None)
    monkeypatch.setattr(engine, "_anonymizer", None)
    monkeypatch.setattr(engine, "_initialized", False)

    seen = []

    def first_scan():
        engine._ensure_initialized()
        seen.append(len(engine._analyzer.registry.recognizers))

    threads = [threading.Thread(target=first_scan) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(built) == 1
    expected = len(engine._get_custom_recognizers())
    assert seen == [expected] * 8  # every caller saw every custom recognizer
