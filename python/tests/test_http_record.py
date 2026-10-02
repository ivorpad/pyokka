"""HTTP record and replay: keys and paths, the hooks and the import hook, httpx sync and async, secrets, the file's lifecycle."""

from __future__ import annotations

import asyncio
import gzip
import hashlib
import json
import os
import platform
import sys
import threading
from types import SimpleNamespace

import httpx
import pytest

from pyokka_runtime import execute, secrets
from pyokka_runtime.plugins import _http_store, http_record
from pyokka_runtime.plugins._http_clients import Finder
from tests.http_record_support import BASE, CHUNKS, ECHO, PLAIN, RECORD, REPLAY, STREAM, async_network, errors, fake_httpx, fake_httpx_async, leaked, lines_of, network, rows
from tests.http_record_support import plugin  # noqa: F401 - fixture


# -- keys and paths ----------------------------------------------------------------------------

def test_request_key_normalises_bodies():
    k = http_record.request_key
    assert k("POST", ECHO, b'{"a": 1, "b": [1, 2]}') == k("post", ECHO, b'{"b":[1,2],\n "a":1}')
    assert k("POST", ECHO, b'{"a": 1}') != k("POST", ECHO, b'{"a": 2}')
    assert k("POST", ECHO, b"hello   world\n") == k("POST", ECHO, b" hello world")
    assert k("POST", ECHO, b"hello world") != k("POST", ECHO, b"hello there")
    assert k("POST", ECHO, b"\xff\x00\x01") == k("POST", ECHO, b"\xff\x00\x01")
    assert k("POST", ECHO, b"\xff\x00\x01") != k("POST", ECHO, b"\xff\x00\x02")
    assert k("GET", PLAIN, None) == k("GET", PLAIN, b"")
    assert k("GET", PLAIN, None) != k("POST", PLAIN, None)
    assert k("GET", PLAIN, None) != k("GET", PLAIN + "?x=1", None)
    assert k("GET", PLAIN, None) == hashlib.sha256(b"GET\n" + PLAIN.encode() + b"\n").hexdigest()


def test_recording_paths(tmp_path):
    ws = tmp_path / "ws"
    (ws / "sub").mkdir(parents=True)
    f = ws / "sub" / "agent.py"
    f.write_text("a = 1\n")
    path = http_record.recording_path(str(ws), str(f))
    digest = hashlib.sha256(os.path.realpath(str(f)).encode()).hexdigest()[:16]
    assert path == str(ws / ".pyokka" / "replay" / (digest + ".jsonl"))
    f.write_text("a = 2\n")
    assert http_record.recording_path(str(ws), str(f)) == path  # edits keep the file
    assert http_record.recording_path(str(ws), str(ws / "sub" / "other.py")) != path
    assert http_record.find_recording(str(ws), str(f)) is None
    local = http_record.recording_path(str(ws / "sub"), str(f))  # `pyokka run` records under the file's directory
    os.makedirs(os.path.dirname(local))
    open(local, "w").close()
    assert http_record.find_recording(str(ws), str(f)) == local
    os.makedirs(os.path.dirname(path))
    open(path, "w").close()
    assert http_record.find_recording(str(ws), str(f)) == path  # the workspace root wins
    ws2 = tmp_path / "ws2"
    ws2.mkdir()
    (ws2 / ".pyokka").write_text("{}")  # the Quokka-style config file
    assert http_record.recording_dir(str(ws2)) == str(ws2 / ".pyokka-replay")
    assert http_record.recording_path(str(ws2), str(f)) == str(ws2 / ".pyokka-replay" / (digest + ".jsonl"))


def test_load_recording_sorts_by_n_and_skips_damaged_lines(tmp_path):
    p = tmp_path / "r.jsonl"
    p.write_text('{"pyokka": "http", "version": 1}\n{"n": 2, "key": "b"}\nnot json\n\n{"n": 1, "key": "a"}\n', encoding="utf-8")
    assert [e["n"] for e in http_record.load_recording(str(p))] == [1, 2]


def test_decode_chunks_keeps_boundaries_and_gives_up_on_the_unknown():
    plain = b'{"hello": "gzip"}' * 50
    gz = gzip.compress(plain)
    out = _http_store.decode_chunks([gz[:20], gz[20:]], "gzip")
    assert b"".join(out) == plain and 1 <= len(out) <= 2
    assert _http_store.decode_chunks([gz], "identity, gzip") == [plain]
    assert _http_store.decode_chunks([b"not gzip"], "gzip") is None
    assert _http_store.decode_chunks([gz], "compress") is None
    assert _http_store.decode_chunks([gz], "gzip, br") is None


# -- modes and hooks -------------------------------------------------------------------------------

@pytest.mark.parametrize("cfg", [{"http": "off"}, {}, None, {"http": "weird"}])
def test_off_observes_without_writing(plugin, cfg, monkeypatch):
    """Mode off: the same patches, a `live` row per request, nothing on disk, no `replayed`."""
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", fake_httpx([]))
    http_record.before_each(cfg)
    assert {"Client._transport_for_url", "AsyncClient._transport_for_url", "HTTPConnection.getresponse", "HTTPAdapter.send"} <= set(leaked()) and isinstance(sys.meta_path[0], Finder)
    with httpx.Client(transport=httpx.HTTPTransport()) as client:
        r = client.post(ECHO, json={"a": 1})
        with client.stream("GET", STREAM) as s:
            chunks = list(s.iter_raw())
    assert r.json() == {"echo": {"a": 1}, "n": 1} and chunks == CHUNKS
    assert [(e["n"], e["source"], e["client"], e["status"], e["reason"], e["bytes"]) for e in rows(plugin)] == [(1, "live", "httpx", 200, "OK", len(r.content)), (2, "live", "httpx", 200, "OK", sum(len(c) for c in CHUNKS))]
    assert all("recordedMs" not in e for e in rows(plugin))
    assert http_record.after(cfg) == {"http": {"mode": "off", "requests": 2, "recorded": 0, "served": 0, "misses": 0, "file": plugin.path, "exists": False, "recordedAt": None, "entries": None}}
    assert not os.path.exists(plugin.path) and leaked() == []


def test_observe_false_patches_nothing(plugin):
    cfg = {"httpObserve": False}
    meta = list(sys.meta_path)
    http_record.before_each(cfg)
    assert leaked() == [] and sys.meta_path == meta
    assert http_record.after(cfg) is None
    assert not os.path.exists(plugin.path)


def test_before_each_twice_replaces_the_session_and_after_is_idempotent(plugin):
    http_record.before_each(RECORD)
    finder = sys.meta_path[0]
    http_record.before_each(RECORD)
    assert isinstance(sys.meta_path[0], Finder) and sys.meta_path[0] is not finder
    assert sum(isinstance(f, Finder) for f in sys.meta_path) == 1
    assert http_record.after(RECORD)["http"]["recorded"] == 0
    assert http_record.after(RECORD) is None
    assert leaked() == []


def test_runner_error_falls_back_to_emit_and_stays_silent_without_a_run(monkeypatch):
    events = []
    monkeypatch.delattr(execute, "runner_error", raising=False)
    monkeypatch.setattr(execute, "current", SimpleNamespace(emit=events.append), raising=False)
    http_record._runner_error("boom")
    assert events == [{"type": "runner.error", "message": "boom"}]
    monkeypatch.setattr(execute, "current", None, raising=False)
    http_record._runner_error("quiet")
    monkeypatch.setattr(execute, "runner_error", lambda m: events.append(m), raising=False)
    http_record._runner_error("via runtime")
    assert events[-1] == "via runtime"


def test_a_module_imported_after_before_each_is_patched_through_the_finder(plugin):
    saved = {k: v for k, v in sys.modules.items() if k == "requests" or k.startswith("requests.")}
    for k in saved:
        del sys.modules[k]
    try:
        http_record.before_each(RECORD)
        import requests.adapters as fresh  # noqa: PLC0415 - the point of the test

        assert fresh is not saved["requests.adapters"]
        assert fresh.HTTPAdapter.send.__module__ == "pyokka_runtime.plugins._http_clients"
        assert fresh.__loader__.get_filename() == fresh.__file__  # the wrapped loader delegates
        http_record.after(RECORD)
        assert fresh.HTTPAdapter.send.__module__ == "requests.adapters"
    finally:
        for k in [k for k in sys.modules if k == "requests" or k.startswith("requests.")]:
            del sys.modules[k]
        sys.modules.update(saved)


# -- httpx ------------------------------------------------------------------------------------------

def test_httpx_sync_record_then_replay(plugin, monkeypatch):
    log = []
    fake = fake_httpx(log)
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", fake)
    http_record.before_each(RECORD)
    with httpx.Client(transport=httpx.HTTPTransport(), headers={"Authorization": "Bearer top-secret-token"}) as client:
        r1 = client.post(ECHO, json={"b": 1, "a": [1, 2]})
        r2 = client.post(ECHO, json={"a": [1, 2], "b": 1})  # the same key: served in order on replay
        r3 = client.get(PLAIN)
        with client.stream("GET", STREAM) as r4:
            chunks = list(r4.iter_raw())
    assert (r1.json()["n"], r2.json()["n"], r3.text, chunks) == (1, 2, "hello", CHUNKS)
    finished = http_record.after(RECORD)
    assert httpx.HTTPTransport.handle_request is fake

    header, *entries = lines_of(plugin.path)
    assert header == {"pyokka": "http", "version": 1, "file": plugin.file, "recorded": header["recorded"], "python": platform.python_version()}
    assert header["recorded"].endswith("Z")
    assert finished == {"http": {"mode": "record", "requests": 4, "recorded": 4, "served": 0, "misses": 0, "file": plugin.path, "exists": True, "recordedAt": header["recorded"], "entries": 4}}
    recorded = rows(plugin)
    assert [(e["n"], e["source"], e["client"], e["method"], e["url"], e["status"], e["reason"]) for e in recorded] == [(1, "recorded", "httpx", "POST", ECHO, 200, "OK"), (2, "recorded", "httpx", "POST", ECHO, 200, "OK"), (3, "recorded", "httpx", "GET", PLAIN, 200, "OK"), (4, "recorded", "httpx", "GET", STREAM, 200, "OK")]
    assert [e["bytes"] for e in recorded] == [len(r1.content), len(r2.content), len(r3.content), sum(len(c) for c in CHUNKS)]
    assert all(e["rid"] == -1 and e["step"] == -1 and isinstance(e["ms"], int) and "recordedMs" not in e for e in recorded)  # no tracer behind the fixture
    assert [e["n"] for e in entries] == [1, 2, 3, 4]
    e1 = entries[0]
    assert e1["client"] == "httpx" and e1["key"] == http_record.request_key("POST", ECHO, b'{"a": [1, 2], "b": 1}')
    assert e1["key"] == entries[1]["key"] != entries[2]["key"]
    assert e1["request"]["method"] == "POST" and e1["request"]["url"] == ECHO
    assert "authorization" not in e1["request"]["headers"]
    assert e1["request"]["headers"]["content-type"] == "application/json"
    assert json.loads(e1["request"]["body"]) == {"b": 1, "a": [1, 2]}
    assert e1["response"]["status"] == 200 and e1["response"]["reason"] == "OK"
    assert e1["response"]["headers"] == {"x-served": "fake", "content-type": "application/json"}
    assert json.loads(e1["response"]["body"]) == {"echo": {"b": 1, "a": [1, 2]}, "n": 1}
    assert e1["response"]["streamed"] is False and e1["response"]["chunks"] is None
    assert isinstance(e1["elapsedMs"], int)
    e4 = entries[3]
    assert e4["response"]["streamed"] is True and e4["response"]["body"] is None
    assert e4["response"]["chunks"] == [c.decode() for c in CHUNKS]
    assert e4["response"]["headers"] == {"content-type": "text/event-stream"}

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", network)
    http_record.before_each(REPLAY)
    with httpx.Client(transport=httpx.HTTPTransport(), headers={"Authorization": "Bearer another-token"}) as client:
        p1 = client.post(ECHO, json={"a": [1, 2], "b": 1})
        p2 = client.post(ECHO, json={"b": 1, "a": [1, 2]})
        p3 = client.post(ECHO, json={"b": 1, "a": [1, 2]})  # used up: the last one repeats
        p4 = client.get(PLAIN)
        with client.stream("GET", STREAM) as p5:
            replayed = list(p5.iter_raw())
        with pytest.raises(ConnectionError, match=r"^pyokka replay: no recorded response for GET %s/missing$" % BASE):
            client.get(BASE + "/missing")
        with pytest.raises(ConnectionError):
            client.get(BASE + "/missing")
        with pytest.raises(ConnectionError):
            client.post(ECHO, json={"other": True})
    assert [p.json()["n"] for p in (p1, p2, p3)] == [1, 2, 2]
    assert (p1.status_code, p1.reason_phrase, p1.headers["x-served"], p1.headers["content-type"]) == (200, "OK", "fake", "application/json")
    assert p1.json() == r1.json() and p1.http_version == "HTTP/1.1"
    assert (p4.status_code, p4.text, p4.headers["content-type"]) == (200, "hello", r3.headers["content-type"])
    assert replayed == chunks
    assert errors(plugin) == ["no recorded response for GET %s/missing; run once in record mode (%s)" % (BASE, plugin.path), "no recorded response for POST %s; run once in record mode (%s)" % (ECHO, plugin.path)]
    replayed = rows(plugin)[4:]
    assert [(e["n"], e["source"], e["status"], e["reason"], e["bytes"], e["recordedMs"]) for e in replayed[:5]] == [
        (1, "replayed", 200, "OK", len(p1.content), entries[0]["elapsedMs"]),
        (2, "replayed", 200, "OK", len(p2.content), entries[1]["elapsedMs"]),
        (3, "replayed", 200, "OK", len(p3.content), entries[1]["elapsedMs"]),  # the repeated entry's latency
        (4, "replayed", 200, "OK", len(p4.content), entries[2]["elapsedMs"]),
        (5, "replayed", 200, "OK", sum(len(c) for c in CHUNKS), entries[3]["elapsedMs"]),
    ]
    # one miss row per attempt, nothing known about an answer
    assert [(e["n"], e["source"], e["method"], e["url"], e["status"], e["reason"], e["bytes"]) for e in replayed[5:]] == [(6, "miss", "GET", BASE + "/missing", None, None, None), (7, "miss", "GET", BASE + "/missing", None, None, None), (8, "miss", "POST", ECHO, None, None, None)]
    assert all("recordedMs" not in e for e in replayed[5:])
    assert http_record.after(REPLAY) == {"http": {"mode": "replay", "requests": 8, "recorded": 0, "served": 5, "misses": 2, "file": plugin.path, "exists": True, "recordedAt": header["recorded"], "entries": 4}, "replayed": True}  # misses counts keys
    assert httpx.HTTPTransport.handle_request is network


def test_httpx_async_record_then_replay(plugin, monkeypatch):
    log = []
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", fake_httpx_async(log))

    async def drive():
        async with httpx.AsyncClient(transport=httpx.AsyncHTTPTransport()) as client:
            r = await client.post(ECHO, json={"x": 1})
            async with client.stream("GET", STREAM) as s:
                chunks = [c async for c in s.aiter_raw()]
            return r.status_code, r.json(), {k: v for k, v in r.headers.items() if k != "content-length"}, chunks, len(r.content)

    http_record.before_each(RECORD)
    recorded = asyncio.run(drive())
    assert recorded[1] == {"echo": {"x": 1}, "n": 1} and recorded[3] == CHUNKS
    assert http_record.after(RECORD)["http"]["recorded"] == 2
    entries = http_record.load_recording(plugin.path)
    assert [e["client"] for e in entries] == ["httpx", "httpx"] and entries[1]["response"]["chunks"] == [c.decode() for c in CHUNKS]
    assert [(e["n"], e["source"], e["client"], e["bytes"]) for e in rows(plugin)] == [(1, "recorded", "httpx", recorded[4]), (2, "recorded", "httpx", sum(len(c) for c in CHUNKS))]

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", async_network)
    http_record.before_each(REPLAY)
    assert asyncio.run(drive()) == recorded
    assert [(e["n"], e["source"], e["recordedMs"]) for e in rows(plugin)[2:]] == [(1, "replayed", entries[0]["elapsedMs"]), (2, "replayed", entries[1]["elapsedMs"])]
    assert http_record.after(REPLAY) == {"http": {"mode": "replay", "requests": 2, "recorded": 0, "served": 2, "misses": 0, "file": plugin.path, "exists": True, "recordedAt": lines_of(plugin.path)[0]["recorded"], "entries": 2}, "replayed": True}


def test_after_writes_what_an_unfinished_stream_captured(plugin, monkeypatch):
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", fake_httpx([]))
    http_record.before_each(RECORD)
    client = httpx.Client(transport=httpx.HTTPTransport())
    response = client.send(client.build_request("GET", STREAM), stream=True)
    it = response.iter_raw()
    assert (next(it), next(it)) == (CHUNKS[0], CHUNKS[1])
    assert http_record.after(RECORD)["http"]["recorded"] == 1
    entry = http_record.load_recording(plugin.path)[0]
    assert entry["response"]["streamed"] is True and entry["response"]["chunks"] == [CHUNKS[0].decode(), CHUNKS[1].decode()]
    assert [(e["source"], e["bytes"]) for e in rows(plugin)] == [("recorded", len(CHUNKS[0]) + len(CHUNKS[1]))]  # the row says what was captured
    response.close()
    client.close()
    assert len(lines_of(plugin.path)) == 2 and len(rows(plugin)) == 1  # closing later does not write it twice


# -- rows: the statement that made the request -----------------------------------------------------------

def test_rows_name_the_innermost_user_statement(plugin, monkeypatch):
    """The frame walk: this file is the tracer's user file, httpx's own frames are skipped, a thread without one gets -1."""
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", fake_httpx([]))
    tracer = plugin.tracer(sys._getframe().f_code.co_filename)
    http_record.before_each(RECORD)
    with httpx.Client(transport=httpx.HTTPTransport()) as client:
        line = sys._getframe().f_lineno + 2
        tracer.steps[tracer.base + line] = 41
        client.get(PLAIN)
        worker = threading.Thread(target=client.get, args=(PLAIN,))
        worker.start()
        worker.join()
    first, second = rows(plugin)
    assert (first["rid"], first["step"]) == (tracer.base + line, 41)
    assert (second["rid"], second["step"]) == (-1, tracer.cur_step)  # no user frame on the worker's stack
    assert http_record.after(RECORD)["http"]["requests"] == 2


def test_binary_bodies_are_stored_as_base64(plugin, monkeypatch):
    blob = bytes(range(256))

    def fake(self, request):
        return httpx.Response(200, content=blob, headers={"content-type": "application/octet-stream"})

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", fake)
    http_record.before_each(RECORD)
    with httpx.Client(transport=httpx.HTTPTransport()) as client:
        assert client.post(BASE + "/bin", content=blob).content == blob
    http_record.after(RECORD)
    entry = http_record.load_recording(plugin.path)[0]
    assert set(entry["request"]["body"]) == {"base64"} and set(entry["response"]["body"]) == {"base64"}
    assert entry["request"]["body"] == entry["response"]["body"]
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", network)
    http_record.before_each(REPLAY)
    with httpx.Client(transport=httpx.HTTPTransport()) as client:
        assert client.post(BASE + "/bin", content=blob).content == blob
    http_record.after(REPLAY)


# -- secrets and the file's lifecycle -----------------------------------------------------------------

def test_secret_values_are_masked_in_the_file_and_the_key_still_matches(plugin, monkeypatch):
    monkeypatch.setenv("MY_API_KEY", "supersecretvalue1")
    secrets.install(True)
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", fake_httpx([]))
    http_record.before_each(RECORD)
    with httpx.Client(transport=httpx.HTTPTransport()) as client:
        r = client.post(BASE + "/secret", json={"q": "supersecretvalue1"}, headers={"X-Token": "supersecretvalue1", "X-Trace": "id supersecretvalue1"})
    assert r.text == "key is supersecretvalue1 ok"  # the program saw the live value
    http_record.after(RECORD)
    with open(plugin.path, encoding="utf-8") as fh:
        text = fh.read()
    assert "supersecretvalue1" not in text
    entry = http_record.load_recording(plugin.path)[0]
    assert entry["request"]["body"] == '{"q":"%s"}' % secrets.MASK
    assert entry["response"]["body"] == "key is %s ok" % secrets.MASK
    assert "x-token" not in entry["request"]["headers"] and entry["request"]["headers"]["x-trace"] == "id " + secrets.MASK

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", network)
    http_record.before_each(REPLAY)
    with httpx.Client(transport=httpx.HTTPTransport()) as client:
        p = client.post(BASE + "/secret", json={"q": "supersecretvalue1"})
    assert p.text == "key is %s ok" % secrets.MASK
    assert http_record.after(REPLAY)["http"]["served"] == 1


def test_second_record_run_replaces_the_file_and_an_idle_run_keeps_it(plugin, monkeypatch):
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", fake_httpx([]))
    http_record.before_each(RECORD)
    with httpx.Client(transport=httpx.HTTPTransport()) as client:
        client.get(PLAIN)
        client.get(PLAIN)
    http_record.after(RECORD)
    assert len(http_record.load_recording(plugin.path)) == 2

    http_record.before_each(RECORD)
    with httpx.Client(transport=httpx.HTTPTransport()) as client:
        client.post(ECHO, json={"second": True})
    http_record.after(RECORD)
    lines = lines_of(plugin.path)
    assert len(lines) == 2 and lines[0]["pyokka"] == "http"
    assert lines[1]["n"] == 1 and lines[1]["request"]["url"] == ECHO

    with open(plugin.path, encoding="utf-8") as fh:
        before = fh.read()
    http_record.before_each(RECORD)
    assert http_record.after(RECORD)["http"]["recorded"] == 0
    with open(plugin.path, encoding="utf-8") as fh:
        assert fh.read() == before
    # an observing run reports the recording on disk without touching it
    http_record.before_each({"http": "off"})
    assert http_record.after({"http": "off"}) == {"http": {"mode": "off", "requests": 0, "recorded": 0, "served": 0, "misses": 0, "file": plugin.path, "exists": True, "recordedAt": lines[0]["recorded"], "entries": 1}}
    with open(plugin.path, encoding="utf-8") as fh:
        assert fh.read() == before
