"""HTTP record and replay: requests, and the http.client fallback (urllib.request, raw connections) against a local server."""

from __future__ import annotations

import gzip
import http.client
import io
import json
import os
import urllib.request

import pytest
import requests
from requests.structures import CaseInsensitiveDict

from pyokka_runtime.plugins import http_record
from tests.http_record_support import BASE, RECORD, REPLAY, errors, leaked, lines_of, network, rows
from tests.http_record_support import plugin, server  # noqa: F401 - fixtures


def test_requests_record_then_replay(plugin, monkeypatch):
    def fake_send(self, request, **kwargs):
        r = requests.Response()
        r.status_code, r.reason = 201, "Created"
        r.headers = CaseInsensitiveDict({"Content-Type": "application/json", "X-Request-Id": "abc"})
        r._content = json.dumps({"echo": json.loads(request.body)}).encode()
        r._content_consumed = True
        r.raw = io.BytesIO(r._content)
        r.url, r.request, r.connection, r.encoding = request.url, request, self, "utf-8"
        return r

    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", fake_send)
    http_record.before_each(RECORD)
    r = requests.post(BASE + "/items", json={"name": "x"}, headers={"X-Api-Key": "k-123456789", "Cookie": "sid=1"})
    assert r.status_code == 201 and r.json() == {"echo": {"name": "x"}}
    assert http_record.after(RECORD)["http"]["recorded"] == 1
    entry = http_record.load_recording(plugin.path)[0]
    assert entry["client"] == "requests" and entry["request"]["url"] == BASE + "/items"
    assert "x-api-key" not in entry["request"]["headers"] and "cookie" not in entry["request"]["headers"]
    assert entry["request"]["headers"]["content-type"] == "application/json"
    assert entry["response"] == {"status": 201, "reason": "Created", "headers": {"content-type": "application/json", "x-request-id": "abc"}, "body": '{"echo": {"name": "x"}}', "streamed": False, "chunks": None}
    assert [(e["n"], e["client"], e["method"], e["url"], e["status"], e["reason"], e["bytes"], e["source"]) for e in rows(plugin)] == [(1, "requests", "POST", BASE + "/items", 201, "Created", len(r.content), "recorded")]

    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", network)
    http_record.before_each(REPLAY)
    p = requests.post(BASE + "/items", json={"name": "x"})
    assert (p.status_code, p.reason, p.json(), p.text, p.encoding) == (r.status_code, r.reason, r.json(), r.text, r.encoding)
    assert dict(p.headers.lower_items()) == dict(r.headers.lower_items())
    assert p.url == r.url and p.request.method == "POST"
    with pytest.raises(ConnectionError, match="pyokka replay: no recorded response for GET"):
        requests.get(BASE + "/other")
    assert [(e["n"], e["client"], e["source"], e["status"], e["bytes"], e.get("recordedMs")) for e in rows(plugin)[1:]] == [(1, "requests", "replayed", 201, len(r.content), entry["elapsedMs"]), (2, "requests", "miss", None, None, None)]
    assert http_record.after(REPLAY) == {"http": {"mode": "replay", "requests": 2, "recorded": 0, "served": 1, "misses": 1, "file": plugin.path, "exists": True, "recordedAt": lines_of(plugin.path)[0]["recorded"], "entries": 1}, "replayed": True}


def test_http_client_fallback_records_urllib_and_raw_connections(plugin, server):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def drive():
        out = {}
        with opener.open(server.url + "/json") as r:
            out["get"] = (r.status, r.headers["Content-Type"], r.read())
        req = urllib.request.Request(server.url + "/echo", data=b'{"k": "v"}', headers={"Content-Type": "application/json"})
        with opener.open(req) as r:
            out["post"] = (r.status, r.read())
        req = urllib.request.Request(server.url + "/gzip", headers={"Accept-Encoding": "gzip"})
        with opener.open(req) as r:
            out["gzip"] = (r.status, r.headers.get("Content-Encoding"), r.read())
        conn = http.client.HTTPConnection("127.0.0.1", server.port)
        conn.request("GET", "/json", headers={"X-Api-Key": "abcdefgh12345"})
        r = conn.getresponse()
        out["raw"] = (r.status, r.reason, r.getheader("Content-Type"), r.read())
        conn.request("GET", "/missing")  # a second request on the same connection
        r = conn.getresponse()
        out["raw404"] = (r.status, r.read())
        conn.close()
        return out

    http_record.before_each(RECORD)
    recorded = drive()
    finished = http_record.after(RECORD)
    header = lines_of(plugin.path)[0]
    assert finished == {"http": {"mode": "record", "requests": 5, "recorded": 5, "served": 0, "misses": 0, "file": plugin.path, "exists": True, "recordedAt": header["recorded"], "entries": 5}}
    assert recorded["get"] == (200, "application/json", b'{"hello": "world"}')
    assert recorded["post"] == (200, b'{"echo": {"k": "v"}}')
    assert recorded["gzip"] == (200, None, b'{"hello": "gzip"}')  # decoded for the program in record mode too
    assert recorded["raw"] == (200, "OK", "application/json", b'{"hello": "world"}')
    assert recorded["raw404"] == (404, b"nope")
    assert server.hits == 5
    entries = http_record.load_recording(plugin.path)
    assert [e["client"] for e in entries] == ["http.client"] * 5 and [e["n"] for e in entries] == [1, 2, 3, 4, 5]
    assert entries[0]["request"] == {"method": "GET", "url": server.url + "/json", "headers": entries[0]["request"]["headers"], "body": None}
    assert entries[0]["request"]["headers"]["host"] == "127.0.0.1:%d" % server.port
    assert entries[1]["request"]["method"] == "POST" and entries[1]["request"]["body"] == '{"k": "v"}'
    gz = entries[2]["response"]
    assert gz["body"] == '{"hello": "gzip"}' and "content-encoding" not in gz["headers"] and "content-length" not in gz["headers"]
    assert gz["headers"]["content-type"] == "application/json" and "date" in gz["headers"]
    assert "x-api-key" not in entries[3]["request"]["headers"]
    assert entries[4]["response"]["status"] == 404 and entries[4]["response"]["body"] == "nope"
    recorded_rows = rows(plugin)
    assert [(e["n"], e["client"], e["method"], e["url"], e["status"], e["reason"], e["source"]) for e in recorded_rows] == [
        (1, "http.client", "GET", server.url + "/json", 200, "OK", "recorded"),
        (2, "http.client", "POST", server.url + "/echo", 200, "OK", "recorded"),
        (3, "http.client", "GET", server.url + "/gzip", 200, "OK", "recorded"),
        (4, "http.client", "GET", server.url + "/json", 200, "OK", "recorded"),
        (5, "http.client", "GET", server.url + "/missing", 404, "Not Found", "recorded"),
    ]
    assert [e["bytes"] for e in recorded_rows] == [18, 20, len(gzip.compress(b'{"hello": "gzip"}')), 18, 4]  # as received: the gzip body still compressed

    server.stop()
    http_record.before_each(REPLAY)
    assert drive() == recorded
    replayed_rows = rows(plugin)[5:]
    assert [(e["n"], e["source"], e["status"], e["bytes"], e["recordedMs"]) for e in replayed_rows] == [(i + 1, "replayed", entries[i]["response"]["status"], size, entries[i]["elapsedMs"]) for i, size in enumerate([18, 20, 17, 18, 4])]  # the stored, decoded sizes
    assert http_record.after(REPLAY) == {"http": {"mode": "replay", "requests": 5, "recorded": 0, "served": 5, "misses": 0, "file": plugin.path, "exists": True, "recordedAt": header["recorded"], "entries": 5}, "replayed": True}
    assert server.hits == 5


def test_http_client_replay_miss_raises_and_the_connection_survives(plugin):
    http_record.before_each(REPLAY)
    conn = http.client.HTTPConnection("127.0.0.1", 9)
    conn.request("GET", "/nothing")
    with pytest.raises(ConnectionError, match="pyokka replay: no recorded response for GET http://127.0.0.1:9/nothing"):
        conn.getresponse()
    conn.request("GET", "/nothing")  # not CannotSendRequest: the state machine was reset
    with pytest.raises(ConnectionError):
        conn.getresponse()
    assert errors(plugin) == ["no recorded response for GET http://127.0.0.1:9/nothing; run once in record mode (%s)" % plugin.path]
    assert [(e["n"], e["client"], e["source"], e["url"], e["status"], e["bytes"]) for e in rows(plugin)] == [(1, "http.client", "miss", "http://127.0.0.1:9/nothing", None, None), (2, "http.client", "miss", "http://127.0.0.1:9/nothing", None, None)]
    assert http_record.after(REPLAY)["http"] == {"mode": "replay", "requests": 2, "recorded": 0, "served": 0, "misses": 1, "file": plugin.path, "exists": False, "recordedAt": None, "entries": None}


def test_end_to_end_through_the_runtime(run, server, tmp_path):
    """`config.http` on a real Execution: the runtime loads the plugin, sets `current`, merges `after` into run.finished, rows name the statement."""
    program = """
        import json, urllib.request
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(%r) as r:
            print(json.loads(r.read())["hello"])
    """ % (server.url + "/json")
    out = run(program, config={"http": "record"})
    path = http_record.recording_path(str(tmp_path), out.path)
    header = lines_of(path)[0]
    assert [e["text"] for e in out.logs] == ["world"]  # an instrumented `print` is a log event
    assert out.finished["http"] == {"mode": "record", "requests": 1, "recorded": 1, "served": 0, "misses": 0, "file": path, "exists": True, "recordedAt": header["recorded"], "entries": 1} and "replayed" not in out.finished
    assert out.finished["exitCode"] == 0 and not out.of("runner.error")
    entry = http_record.load_recording(path)[0]
    assert entry["client"] == "http.client"
    [row] = out.of("http.exchange")
    assert row["rid"] == out.rid_at(4) and row["step"] >= 0  # the `with opener.open(...)` statement
    assert (row["n"], row["client"], row["method"], row["url"], row["status"], row["bytes"], row["source"]) == (1, "http.client", "GET", server.url + "/json", 200, 18, "recorded")

    server.stop()
    out = run(program, config={"http": "replay"})
    assert [e["text"] for e in out.logs] == ["world"]
    assert out.finished["http"] == {"mode": "replay", "requests": 1, "recorded": 0, "served": 1, "misses": 0, "file": path, "exists": True, "recordedAt": header["recorded"], "entries": 1} and out.finished["replayed"] is True
    assert out.finished["exitCode"] == 0 and not out.of("runner.error")
    [row] = out.of("http.exchange")
    assert (row["rid"], row["source"], row["recordedMs"]) == (out.rid_at(4), "replayed", entry["elapsedMs"]) and row["step"] >= 0
    assert leaked() == []


def test_rows_from_worker_threads_name_their_own_statement(run, server, tmp_path):
    """The default config observes: two requests from pool threads carry the rid of the statement that made them, nothing is written."""
    program = """
        import json, urllib.request
        from concurrent.futures import ThreadPoolExecutor
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

        def fetch(path):
            with opener.open(BASE + path) as r:
                return json.loads(r.read())

        def fetch_raw(path):
            body = opener.open(BASE + path).read()
            return json.loads(body)

        BASE = %r
        with ThreadPoolExecutor(max_workers=2) as pool:
            a = pool.submit(fetch, "/json")
            b = pool.submit(fetch_raw, "/json")
            print(a.result()["hello"], b.result()["hello"])
    """ % server.url
    out = run(program)
    assert [e["text"] for e in out.logs] == ["world world"] and not out.of("runner.error")
    by_rid = sorted(out.of("http.exchange"), key=lambda e: e["rid"])
    assert [e["rid"] for e in by_rid] == sorted([out.rid_at(7), out.rid_at(11)]) and all(e["step"] >= 0 for e in by_rid)
    assert [(e["source"], e["client"], e["status"], e["bytes"]) for e in by_rid] == [("live", "http.client", 200, 18)] * 2
    path = http_record.recording_path(str(tmp_path), out.path)
    assert out.finished["http"] == {"mode": "off", "requests": 2, "recorded": 0, "served": 0, "misses": 0, "file": path, "exists": False, "recordedAt": None, "entries": None} and "replayed" not in out.finished
    assert not os.path.exists(path) and server.hits == 2 and leaked() == []


def test_requests_off_does_not_buffer_the_body(plugin, server):
    http_record.before_each({"http": "off"})
    s = requests.Session()
    s.trust_env = False
    try:
        r = s.get(server.url + "/json", stream=True)
        assert r._content is False  # nothing was read on the program's behalf
        assert r.raw.read(5) == b'{"hel' and r.raw.read() == b'lo": "world"}'
        p = s.post(server.url + "/echo", json={"a": 1})
    finally:
        s.close()
    assert p.json() == {"echo": {"a": 1}}
    # one row per request (the http.client hooks let the adapter's own connection pass), sizes from content-length
    assert [(e["n"], e["client"], e["method"], e["status"], e["bytes"], e["source"]) for e in rows(plugin)] == [(1, "requests", "GET", 200, 18, "live"), (2, "requests", "POST", 200, len(p.content), "live")]
    assert http_record.after({"http": "off"})["http"]["requests"] == 2
    assert not os.path.exists(plugin.path) and server.hits == 2


def test_http_client_off_leaves_the_response_untouched(plugin, server):
    http_record.before_each({})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(server.url + "/gzip", headers={"Accept-Encoding": "gzip"})
    with opener.open(req) as r:
        assert r.headers.get("Content-Encoding") == "gzip" and not isinstance(r.fp, io.BytesIO)  # the network's response object, not a rebuilt one
        raw = r.read()
    assert gzip.decompress(raw) == b'{"hello": "gzip"}'
    payload = json.dumps({"k": "v" * 100_000}).encode()  # a body past the header block passes straight through
    conn = http.client.HTTPConnection("127.0.0.1", server.port)
    conn.request("POST", "/echo", body=payload, headers={"Content-Type": "application/json"})
    echoed = conn.getresponse()
    assert echoed.status == 200 and json.loads(echoed.read()) == {"echo": {"k": "v" * 100_000}}
    conn.close()
    assert [(e["n"], e["client"], e["method"], e["url"], e["status"], e["bytes"], e["source"]) for e in rows(plugin)] == [(1, "http.client", "GET", server.url + "/gzip", 200, len(raw), "live"), (2, "http.client", "POST", server.url + "/echo", 200, len(payload) + len(b'{"echo": }'), "live")]
    assert http_record.after({})["http"]["mode"] == "off" and not os.path.exists(plugin.path) and server.hits == 2


def test_requests_over_http_client_records_once(plugin, server):
    def drive():
        s = requests.Session()
        s.trust_env = False
        try:
            r = s.get(server.url + "/json")
            p = s.post(server.url + "/echo", json={"a": 1})
        finally:
            s.close()
        return (r.status_code, r.json(), r.headers["Content-Type"]), (p.status_code, p.json())

    http_record.before_each(RECORD)
    recorded = drive()
    assert recorded == ((200, {"hello": "world"}, "application/json"), (200, {"echo": {"a": 1}}))
    assert http_record.after(RECORD)["http"]["recorded"] == 2
    entries = http_record.load_recording(plugin.path)
    assert [(e["client"], e["n"]) for e in entries] == [("requests", 1), ("requests", 2)]
    assert entries[0]["request"]["url"] == server.url + "/json"
    assert "content-length" not in entries[0]["response"]["headers"]

    server.stop()
    http_record.before_each(REPLAY)
    assert drive() == recorded
    assert http_record.after(REPLAY)["http"]["served"] == 2
