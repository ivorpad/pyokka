"""`pyokka http` without a run: the table over rows (names, order, totals, misses, the cap) and its text form."""

from __future__ import annotations

import os
from types import SimpleNamespace

from pyokka_runtime.agent.http import CAP, format_bytes, http_table, recording_label, render_http, request_name

URL = "https://api.openai.com/v1/responses"
RECORDING = {"mode": "replay", "requests": 3, "recorded": 0, "served": 2, "misses": 1, "file": "/ws/.pyokka/replay/3f2a9c1e5b7d0246.jsonl", "exists": True, "recordedAt": "2026-09-11T10:12:03Z", "entries": 2}
SOURCE = SimpleNamespace(display_path=lambda p: os.path.basename(p))


def row(n: int, **over) -> dict:
    base = {"type": "http.exchange", "runId": "r-1", "n": n, "client": "httpx", "method": "POST", "url": URL, "status": 200, "reason": "OK", "bytes": 100 * n, "ms": 10 * n, "source": "recorded", "rid": 17, "step": 80 + n}
    base.update(over)
    return base


def locate(rid: int) -> dict | None:
    return {"file": "/ws/agent.py", "line": rid - 1, "col": 0, "fileId": 1} if rid > 0 else None


def test_table_lists_rows_in_request_order_with_names_totals_and_locations():
    events = [{"type": "log", "text": "x"}, row(2, source="replayed", recordedMs=1834), row(1), row(3, source="miss", status=None, reason=None, bytes=None, url="https://api.openai.com/v1/models?key&v", rid=-1, step=-1)]
    table = http_table(events, RECORDING, locate=locate)
    assert (table["runId"], table["running"], table["count"], table["truncated"]) == ("r-1", False, 3, False)
    assert [r["n"] for r in table["requests"]] == [1, 2, 3]  # request order, not emission order
    assert table["totals"] == {"requests": 3, "bytes": 300, "ms": 60, "misses": 1, "missAttempts": 1}
    assert table["requests"][0] == {"n": 1, "client": "httpx", "method": "POST", "url": URL, "name": "responses", "status": 200, "reason": "OK", "bytes": 100, "ms": 10, "recordedMs": None, "source": "recorded", "step": 81, "location": {"file": "/ws/agent.py", "line": 16, "col": 0, "fileId": 1}}
    assert table["requests"][1]["recordedMs"] == 1834
    assert table["requests"][2]["location"] is None and table["requests"][2]["name"] == "models" and table["requests"][2]["step"] == -1
    assert table["finished"] is RECORDING


def test_misses_while_running_count_distinct_requests():
    events = [row(1, source="miss", status=None, reason=None, bytes=None), row(2, source="miss", status=None, reason=None, bytes=None), row(3, source="miss", status=None, reason=None, bytes=None, url=URL + "/other")]
    table = http_table(events, None, running=True, locate=locate, run_id="r-9")
    assert table["runId"] == "r-9" and table["running"] is True and table["finished"] is None
    assert table["totals"] == {"requests": 3, "bytes": 0, "ms": 60, "misses": 2, "missAttempts": 3}
    assert render_http(table, SOURCE)[0] == "3 requests · 0 B · 60 ms · running"
    assert http_table([], None, locate=locate) == {"runId": None, "running": False, "count": 0, "truncated": False, "totals": {"requests": 0, "bytes": 0, "ms": 0, "misses": 0, "missAttempts": 0}, "finished": None, "requests": []}


def test_cap_keeps_the_first_500_rows():
    table = http_table([row(n) for n in range(600, 0, -1)], {"mode": "off", "requests": 600, "recorded": 0, "served": 0, "misses": 0, "file": "/ws/x.jsonl", "exists": False, "recordedAt": None, "entries": None}, locate=locate)
    assert table["count"] == 600 and table["truncated"] is True and len(table["requests"]) == CAP and table["requests"][-1]["n"] == CAP
    assert table["totals"]["requests"] == 600
    lines = render_http(table, SOURCE)
    assert lines[0] == "600 requests · 18 MB · 1803.0 s · HTTP off" and lines[-1] == "… 100 more requests not listed (the table keeps the first 500)"
    assert len(lines) == CAP + 2


def test_request_name_rule():
    assert request_name("https://api.openai.com/v1/responses") == "responses"
    assert request_name("https://api.openai.com/v1/responses/?stream") == "responses"
    assert request_name("https://api.openai.com") == "api.openai.com" and request_name("http://127.0.0.1:8080/") == "127.0.0.1"
    assert request_name("https://h/" + "x" * 80) == "x" * 59 + "…"


def test_sizes():
    assert [format_bytes(v) for v in (0, 18, 999, 1000, 6812, 68123, 999_949, 1_500_000, None)] == ["0 B", "18 B", "999 B", "1.0 kB", "6.8 kB", "68 kB", "1000 kB", "1.5 MB", "—"]


def test_text_form_lines():
    events = [row(1, bytes=6812, ms=1834, url=URL, rid=17, step=88), row(2, source="miss", status=None, reason=None, bytes=None, ms=3, method="GET", url="https://api.openai.com/v1/models", rid=-1, step=-1), row(3, url="https://example.test/" + "a" * 120)]
    lines = render_http(http_table(events, RECORDING, locate=locate), SOURCE)
    assert lines[0] == "3 requests · 7.1 kB · 1.9 s · replayed from 3f2a….jsonl (2026-09-11 10:12Z), 1 missing (1 attempt)"
    assert lines[1] == "#1  POST  200  responses  agent.py:16  6.8 kB  1.8 s  recorded  https://api.openai.com/v1/responses"
    assert lines[2] == "#2  GET  MISS  models  —  —  3 ms  miss  https://api.openai.com/v1/models"
    assert len(lines[3]) == 100 and lines[3].endswith("…")
    assert recording_label({"file": "/ws/.pyokka/replay/3f2a9c1e5b7d0246.jsonl", "recordedAt": None}) == "3f2a….jsonl"
    assert recording_label({"file": "/ws/short.jsonl", "recordedAt": "2026-09-11T10:12:03Z"}) == "short.jsonl (2026-09-11 10:12Z)"


def test_header_variants():
    off = {"mode": "off", "requests": 1, "recorded": 0, "served": 0, "misses": 0, "file": "/ws/x.jsonl", "exists": False, "recordedAt": None, "entries": None}
    assert render_http(http_table([row(1, source="live")], off, locate=locate), SOURCE)[0] == "1 request · 100 B · 10 ms · HTTP off"
    recorded = dict(off, mode="record", recorded=1, exists=True, recordedAt="2026-09-11T10:12:03Z", entries=1, file="/ws/.pyokka/replay/3f2a9c1e5b7d0246.jsonl")
    assert render_http(http_table([row(1)], recorded, locate=locate), SOURCE)[0] == "1 request · 100 B · 10 ms · recorded to 3f2a….jsonl (2026-09-11 10:12Z)"
    assert render_http(http_table([], dict(off, mode="record", requests=0), locate=locate), SOURCE) == ["0 requests · 0 B · 0 ms · HTTP record, nothing written", "no request was observed: the program made none, or the run had httpObserve off"]
    assert render_http(http_table([], None, locate=locate), SOURCE)[0] == "0 requests · 0 B · 0 ms"
