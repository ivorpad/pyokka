"""Shared pieces of the http_record tests: the plugin fixture, canned httpx originals, a local HTTP server. No network."""

from __future__ import annotations

import gzip
import http.client
import http.server
import json
import sys
import threading
import time
from types import SimpleNamespace

import aiohttp
import httpx
import pytest
import requests

from pyokka_runtime import execute
from pyokka_runtime.plugins import http_record
from pyokka_runtime.plugins._http_clients import Finder

RECORD = {"http": "record"}
REPLAY = {"http": "replay"}
BASE = "https://api.example.test"
ECHO, PLAIN, STREAM = BASE + "/echo", BASE + "/plain", BASE + "/stream"
CHUNKS = [b"data: 1\n\n", b"data: 2\n\n", b"data: 3\n\n"]

TARGETS = [
    (http.client.HTTPConnection, "putrequest"),
    (http.client.HTTPConnection, "send"),
    (http.client.HTTPConnection, "connect"),
    (http.client.HTTPConnection, "getresponse"),
    (http.client.HTTPSConnection, "connect"),
    (httpx.Client, "_transport_for_url"),
    (httpx.AsyncClient, "_transport_for_url"),
    (requests.adapters.HTTPAdapter, "send"),
    (aiohttp.ClientSession, "_request"),
    (aiohttp.StreamReader, "feed_data"),
]


def leaked() -> list[str]:
    """Patched attributes still in place: the plugin's wrappers are the only functions defined in its modules."""
    return ["%s.%s" % (cls.__name__, name) for cls, name in TARGETS if getattr(getattr(cls, name), "__module__", "").startswith("pyokka_runtime.plugins")]


class TracerStub:
    """What `_Session.position` reads of a tracer: the files, `rid_at`, `step_for`, `cur_step`.

    File 1 is `filename` (user code; a line's rid is `base + line`), file 2 a library file the walk must never name.
    """

    def __init__(self, filename: str, *, base: int = 1000, cur_step: int = 7) -> None:
        self.files_by_id = {1: SimpleNamespace(filename=filename, library=False), 2: SimpleNamespace(filename="/site-packages/lib/x.py", library=True)}
        self.base = base
        self.cur_step = cur_step
        self.steps: dict[int, int] = {}  # rid -> the step `step_for` answers; any other rid gets `cur_step`

    def rid_at(self, info, line: int) -> int:
        return self.base + line

    def step_for(self, rid: int) -> int:
        return self.steps.get(rid, self.cur_step)


@pytest.fixture
def plugin(tmp_path, monkeypatch):
    """`execute.current` for the duration; `after()` on the way out so patches never leak, even from a failing test.

    `execute.runner_error` is removed so misses go through `current.emit`, whatever the runtime wiring does.
    There is no tracer unless a test asks for the stub (`ctx.tracer(filename)`): rows then carry `rid: -1`.
    """
    events: list[dict] = []
    scratch = str(tmp_path / "scratch.py")
    monkeypatch.delattr(execute, "runner_error", raising=False)
    execute.current = SimpleNamespace(spec=SimpleNamespace(file_path=scratch, workspace_root=str(tmp_path)), emit=events.append)
    assert leaked() == []

    def tracer(filename: str, **kw) -> TracerStub:
        stub = TracerStub(filename, **kw)
        execute.current.tracer = stub
        return stub

    try:
        yield SimpleNamespace(root=str(tmp_path), file=scratch, events=events, path=http_record.recording_path(str(tmp_path), scratch), tracer=tracer)
    finally:
        http_record.after(RECORD)
        execute.current = None
        assert leaked() == []
        assert not any(isinstance(f, Finder) for f in sys.meta_path)


def lines_of(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as fh:
        return [json.loads(line) for line in fh.read().splitlines()]


def errors(ctx) -> list[str]:
    return [e["message"] for e in ctx.events if e.get("type") == "runner.error"]


def rows(ctx) -> list[dict]:
    """The `http.exchange` events emitted so far, in emission order."""
    return [e for e in ctx.events if e.get("type") == "http.exchange"]


# -- canned httpx originals -----------------------------------------------------------------------

class Chunks(httpx.SyncByteStream):
    def __init__(self, chunks):
        self.chunks = chunks

    def __iter__(self):
        yield from self.chunks


class AsyncChunks(httpx.AsyncByteStream):
    def __init__(self, chunks):
        self.chunks = chunks

    async def __aiter__(self):
        for c in self.chunks:
            yield c


def canned(request: httpx.Request, body: bytes, n: int, stream_cls) -> httpx.Response:
    path = request.url.path
    if path == "/echo":
        return httpx.Response(200, json={"echo": json.loads(body), "n": n}, headers={"x-served": "fake"})
    if path == "/plain":
        return httpx.Response(200, text="hello", headers={"x-served": "fake"})
    if path == "/stream":
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=stream_cls(CHUNKS))
    if path == "/secret":
        return httpx.Response(200, text="key is supersecretvalue1 ok")
    return httpx.Response(404, text="nope")


def fake_httpx(log: list):
    def handle_request(self, request):
        log.append(request)
        return canned(request, request.read(), len(log), Chunks)

    return handle_request


def fake_httpx_async(log: list):
    async def handle_async_request(self, request):
        log.append(request)
        return canned(request, await request.aread(), len(log), AsyncChunks)

    return handle_async_request


def network(*args, **kwargs):
    raise AssertionError("the network was reached")


async def async_network(*args, **kwargs):
    raise AssertionError("the network was reached")


# -- a local server for the http.client stack ---------------------------------------------------

class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.server.hits += 1
        path = self.path
        if path == "/gzip":
            self.reply(200, gzip.compress(b'{"hello": "gzip"}'), {"Content-Type": "application/json", "Content-Encoding": "gzip"})
        elif path == "/sse":  # chunked transfer, one event per flushed chunk
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            for event in CHUNKS:
                self.wfile.write(b"%x\r\n%s\r\n" % (len(event), event))
                self.wfile.flush()
                time.sleep(0.02)
            self.wfile.write(b"0\r\n\r\n")
        elif path == "/json":
            self.reply(200, b'{"hello": "world"}', {"Content-Type": "application/json", "X-Count": str(self.server.hits)})
        else:
            self.reply(404, b"nope", {"Content-Type": "text/plain"})

    def do_POST(self):
        self.server.hits += 1
        data = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self.reply(200, json.dumps({"echo": json.loads(data)}).encode(), {"Content-Type": "application/json"})

    def reply(self, status, body, headers):
        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class LocalServer:
    def __init__(self):
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.block_on_close = False
        self.server.hits = 0
        self.port = self.server.server_address[1]
        self.url = "http://127.0.0.1:%d" % self.port
        self.stopped = False
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def hits(self):
        return self.server.hits

    def stop(self):
        if not self.stopped:
            self.stopped = True
            self.server.shutdown()
            self.server.server_close()


@pytest.fixture
def server():
    s = LocalServer()
    yield s
    s.stop()
